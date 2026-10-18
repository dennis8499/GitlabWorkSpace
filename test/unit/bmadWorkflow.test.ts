import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BmadReadCache, parseBmadCatalog, readBmadWorkflow } from '../../src/workspace/bmadWorkflow';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

const HEADER = 'module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs';
const CATALOG = [HEADER,
  'BMad Method,_meta,,,,,,,,,false,https://docs.bmad-method.org/,',
  'BMad Method,bmad-product-brief,Brief,CB,"A brief, with context",,-A,plan,,,false,planning_artifacts,product brief',
  'BMad Method,bmad-prd,PRD,PRD,Requirements,,,2-planning,bmad-product-brief,,true,planning_artifacts,prd',
  'BMad Method,bmad-ux,UX,UX,Design,,,2-planning,bmad-prd,,false,planning_artifacts,ux design',
  'BMad Method,bmad-architecture,Architecture,CA,Architecture,,,plan,,,true,planning_artifacts,architecture',
  'BMad Method,bmad-create-epics-and-stories,Epics,CE,Epics,,,plan,bmad-architecture,,true,planning_artifacts,epics',
  'BMad Method,bmad-sprint-planning,Sprint,SP,Plan,,,plan,,,true,implementation_artifacts,sprint status',
  'BMad Method,bmad-sprint-planning,Status,SS,Status,status,,anytime,,,false,,status summary',
  'BMad Method,bmad-build,Build,BD,Build,,,ship,bmad-sprint-planning,bmad-code-review,true,implementation_artifacts,spec and project implementation',
  'BMad Method,bmad-code-review,Review,CR,Review,,,ship,bmad-build,,false,,',
  'BMad Method,bmad-spec,Spec,SPC,Spec,,[path],anytime,,,false,{output_folder}/specs/spec-{slug},SPEC.md + companion files'
].join('\n');
const md = (status?: string, rest = 'Content'): string => status === undefined ? rest : `---\nstatus: ${status}\n---\n${rest}\n`;
// v6.12.4 bmad-spec/assets/stories-schema.md: an ordered top-level list, not a status board.
const INVENTORY = `- id: "1"
  title: Add rate limiting to the public API
  description: >-
    Introduce a token-bucket limiter in front of the public endpoints;
    return 429 with a Retry-After header on limit breach.
  spec_checkpoint: true
  invoke_dev_with: >-
    Rate limit state must be shared across instances; use the existing
    Redis client, not in-process memory.
- id: "2"
  title: Expose limiter metrics to the ops dashboard
  description: >-
    Emit per-route accept/reject counters the existing dashboard can
    scrape; no new dashboard panels in this story.
`;
async function fixture(run: (root: string, write: (relative: string, content: string) => Promise<void>) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmad-test-'));
  const write = async (relative: string, content: string): Promise<void> => { const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
  try {
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: 6.12.4\nmodules:\n  - name: bmm\n');
    await write('_bmad/_config/bmad-help.csv', CATALOG);
    await write('_bmad/config.toml', '[core]\noutput_folder = \"_bmad-output\"\n');
    await write('_bmad/scripts/resolve_config.py', '# Official resolver fixture');
    await write('_bmad/scripts/render_skill.py', '# Official renderer fixture');
    for (const skill of new Set(['bmad-help', ...parseBmadCatalog(CATALOG).map(node => node.skill)])) await write(`.agents/skills/${skill}/SKILL.md`, `# ${skill}`);
    await run(root, write);
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'bmad-test-')));
    await fs.rm(root, { recursive: true, force: true });
  }
}
const read = (root?: string) => readBmadWorkflow({ root, bundledCatalog: CATALOG });
const step = (snapshot: BmadWorkflowSnapshot, skill: string) => snapshot.steps.find(item => snapshot.nodes.find(node => node.id === item.id)?.skill === skill)!;

test('an aborted BMAD read stops before reading the project', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readBmadWorkflow({ root: '/unused', bundledCatalog: CATALOG, signal: controller.signal } as Parameters<typeof readBmadWorkflow>[0]), { name: 'AbortError' });
});

test('incremental BMAD cache reuses unchanged parsing and invalidates changed file identity', async () => {
  await fixture(async (root, write) => {
    const cache = new BmadReadCache();
    await write('_bmad-output/planning-artifacts/prd.md', md('draft'));
    const first = await readBmadWorkflow({ root, bundledCatalog: CATALOG, cache });
    let parses = 0;
    const firstValue = cache.derive('test-value', 10, () => { parses++; return { parsed: true }; });
    assert.equal(cache.derive('test-value', 10, () => { parses++; return {}; }), firstValue); assert.equal(parses, 1);
    const unchanged = await readBmadWorkflow({ root, bundledCatalog: CATALOG, cache }); assert.equal(unchanged.revision, first.revision);
    await write('_bmad-output/planning-artifacts/prd.md', md('final'));
    const changed = await readBmadWorkflow({ root, bundledCatalog: CATALOG, cache });
    assert.equal(step(changed, 'bmad-prd').status, 'complete'); assert.notEqual(changed.revision, first.revision);
    cache.clear();
  });
});

test('catalog supports RFC quoting, action identities, soft edges and future phases', async () => {
  const nodes = parseBmadCatalog(CATALOG);
  assert.equal(nodes[0].description, 'A brief, with context');
  assert.equal(nodes.filter(node => node.skill === 'bmad-sprint-planning').length, 2);
  assert.notEqual(nodes.find(node => node.action === 'status')!.id, nodes.find(node => node.skill === 'bmad-sprint-planning' && !node.action)!.id);
  assert.throws(() => parseBmadCatalog(`${HEADER}\n"unfinished`), /寫完/);
  const snapshot = await readBmadWorkflow({ bundledCatalog: `${CATALOG}\nOther,bmad-new-skill,Future,FU,Unknown,,,future,,,false,,` });
  assert.equal(snapshot.installation.state, 'missing');
  assert.equal(snapshot.steps.length, 11);
  assert.ok(snapshot.phases.some(phase => phase.id === 'future'));
  assert.ok(snapshot.edges.some(edge => edge.to.endsWith(':bmad-code-review:')));
  assert.equal(snapshot.currentCandidates.length, 0);
});

test('absent and unsupported installations still expose the complete guidance catalog', async () => {
  await fixture(async (root, write) => {
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: 7.0.0\n');
    await write('_bmad-output/planning-artifacts/prd.md', md('final'));
    const snapshot = await read(root);
    assert.equal(snapshot.installation.state, 'unsupported');
    assert.equal(snapshot.catalogSource, 'guidance');
    assert.equal(step(snapshot, 'bmad-prd').status, 'not-observed');
  });
});

test('external CLI installation is detected without Workflow Kit and validates actual Codex skills', async () => {
  await fixture(async (root, write) => {
    let snapshot = await read(root);
    assert.equal(snapshot.guidanceVersion, '6.12.4');
    assert.equal(snapshot.compatibility, 'verified');
    assert.equal(snapshot.installation.state, 'ready');
    assert.equal(snapshot.catalogSource, 'installed');
    assert.equal(snapshot.codex.state, 'ready');
    await assert.rejects(fs.access(path.join(root, '.agents/gitlab-workspace-kit')));
    await write('_bmad-output/planning-artifacts/prd.md', md('final'));
    await fs.unlink(path.join(root, '.agents/skills/bmad-build/SKILL.md'));
    snapshot = await read(root);
    assert.equal(snapshot.installation.state, 'ready');
    assert.equal(snapshot.codex.state, 'partial');
    assert.equal(snapshot.codex.skills.includes('bmad-build'), false);
    assert.equal(snapshot.codex.skills.includes('bmad-prd'), true);
    assert.equal(step(snapshot, 'bmad-prd').status, 'complete', 'A missing Codex skill does not erase native progress');
    await write('.agents/skills/bmad-build/SKILL.md', '# Restored by external installer');
    assert.equal((await read(root)).codex.state, 'ready');
    await fs.unlink(path.join(root, '_bmad/scripts/render_skill.py'));
    snapshot = await read(root);
    assert.equal(snapshot.installation.state, 'partial');
    assert.equal(step(snapshot, 'bmad-prd').status, 'not-observed');
  });
});

test('directory observation covers runtime, Skill leaves and every discovered nested artifact directory', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/implementation-artifacts/nested/spec-feature.md', md('draft'));
    const snapshot = await read(root);
    for (const relative of ['_bmad/scripts', '.agents', '.agents/skills', '.agents/skills/bmad-build',
      '_bmad-output/implementation-artifacts/nested']) {
      assert.ok(snapshot.watchDirectories.includes(path.join(root, relative)), `Missing direct observation for ${relative}`);
    }
  });
});

test('missing, interrupted, malformed and restored installation states remain distinct', async () => {
  await fixture(async (root, write) => {
    await fs.unlink(path.join(root, '_bmad/_config/manifest.yaml'));
    assert.equal((await read(root)).installation.state, 'partial');
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: [half-written\n');
    assert.equal((await read(root)).installation.state, 'error');
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: 6.12.4\n');
    await fs.unlink(path.join(root, '_bmad/_config/bmad-help.csv'));
    assert.equal((await read(root)).installation.state, 'partial');
    await write('_bmad/_config/bmad-help.csv', 'broken,catalog\n');
    assert.equal((await read(root)).installation.state, 'error');
    await write('_bmad/_config/bmad-help.csv', CATALOG);
    assert.equal((await read(root)).installation.state, 'ready');
    await write('_bmad/scripts/render_skill.py', '');
    assert.equal((await read(root)).installation.state, 'partial', 'An empty runtime file is an interrupted installation');
    await write('_bmad/scripts/render_skill.py', '# Restored renderer');
    await write('_bmad/config.toml', '');
    assert.equal((await read(root)).installation.state, 'partial', 'An empty central configuration is incomplete');
  });
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'bmad-test-empty-'));
  try {
    const snapshot = await read(empty);
    assert.equal(snapshot.installation.state, 'missing');
    assert.equal(snapshot.codex.state, 'missing');
    assert.equal(snapshot.catalogSource, 'guidance');
    assert.ok(snapshot.watchDirectories.includes(path.join(snapshot.root!, '.agents/skills')));
    assert.deepEqual(await fs.readdir(empty), [], 'Observation never initializes a project');
  } finally { await fs.rm(empty, { recursive: true, force: true }); }
});

test('same-major versions use installed catalog with an explicit unverified label and future major versions stay unsupported', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/prd.md', md('final'));
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: 6.12.5\n');
    let snapshot = await read(root);
    assert.equal(snapshot.compatibility, 'unverified');
    assert.equal(snapshot.catalogSource, 'installed');
    assert.equal(step(snapshot, 'bmad-prd').status, 'complete');
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: 7.0.0-alpha.1\n');
    snapshot = await read(root);
    assert.equal(snapshot.compatibility, 'unsupported');
    assert.equal(snapshot.installation.state, 'unsupported');
    assert.equal(snapshot.catalogSource, 'guidance');
    assert.equal(step(snapshot, 'bmad-prd').status, 'not-observed');
    await write('_bmad/_config/manifest.yaml', 'installation:\n  modules: [core, bmm]\n');
    snapshot = await read(root);
    assert.equal(snapshot.compatibility, 'unknown');
    assert.equal(snapshot.installation.state, 'partial');
  });
});

test('invalid installation parsers report an observation failure and recover after an external correction', async () => {
  await fixture(async (root, write) => {
    for (const [filename, broken, restored] of [
      ['_bmad/config.toml', '[unfinished', '[core]\noutput_folder = "_bmad-output"\n'],
      ['_bmad/_config/manifest.yaml', 'installation:\n  version: [unfinished\n', 'installation:\n  version: 6.12.4\n'],
      ['_bmad/_config/bmad-help.csv', 'broken,catalog\n', CATALOG]
    ]) {
      await write(filename, broken);
      const invalid = await read(root);
      assert.equal(invalid.installation.state, 'error', filename);
      assert.equal(invalid.observation.state, 'error', filename);
      assert.ok(invalid.observation.error, filename);
      assert.equal(invalid.observation.lastSuccessfulAt, undefined);
      await write(filename, restored);
      const recovered = await read(root);
      assert.equal(recovered.installation.state, 'ready', filename);
      assert.equal(recovered.observation.error, undefined, filename);
      assert.ok(recovered.observation.lastSuccessfulAt, filename);
    }
  });
});

test('native Auto blocked status remains blocked and resumes only after the recorded state changes', async () => {
  await fixture(async (root, write) => {
    const prefix = '_bmad-output/specs/spec-example';
    await write(`${prefix}/stories.yaml`, '- id: "1"\n  title: Example\n  description: Native Auto work\n');
    await write(`${prefix}/stories/1-example.md`, '---\nstatus: blocked\nblocked_reason: Missing test dependency\n---\n');
    let snapshot = await read(root);
    const build = step(snapshot, 'bmad-build');
    assert.equal(build.status, 'blocked');
    assert.equal(build.artifacts[0].status, 'blocked');
    assert.equal(build.artifacts[0].stage, 'Build 受阻');
    assert.equal(snapshot.stories[0].nativeStatus, 'blocked');
    assert.ok(snapshot.currentCandidates.some(candidate => candidate.storyId));
    await write(`${prefix}/stories/1-example.md`, md('in-progress'));
    snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-build').status, 'draft');
    await write(`${prefix}/stories/1-example.md`, md('done'));
    assert.equal(step(await read(root), 'bmad-build').status, 'complete');
  });
});

test('file existence and stepsCompleted never imply final completion', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/prd.md', '---\nstepsCompleted: [1, 2, 3, 4, 99]\nstatus: draft\n---\n');
    const snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'draft');
    await write('_bmad-output/planning-artifacts/prd.md', md('final'));
    const final = await read(root);
    assert.equal(step(final, 'bmad-prd').status, 'complete');
    assert.notEqual(snapshot.revision, final.revision);
  });
});

test('UX requires both final documents and multiple artifacts retain distinct states', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/DESIGN.md', md('final'));
    assert.equal(step(await read(root), 'bmad-ux').status, 'draft');
    await write('_bmad-output/planning-artifacts/EXPERIENCE.md', md('final'));
    assert.equal(step(await read(root), 'bmad-ux').status, 'complete');
    await write('_bmad-output/planning-artifacts/old/prd.md', md('final'));
    await write('_bmad-output/planning-artifacts/new/prd.md', md('draft'));
    const snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'draft');
    assert.equal(step(snapshot, 'bmad-prd').artifacts.length, 2);
    assert.ok(snapshot.currentCandidates.some(candidate => candidate.label.includes('new/prd.md')));
    assert.equal(snapshot.currentCandidates.some(candidate => candidate.label.includes('old/prd.md')), false);
  });
});

test('historical manual confirmations cannot change native evidence or create completion', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/brief.md', md(undefined));
    const initial = await read(root); const initialStep = step(initial, 'bmad-product-brief'); const artifact = initialStep.artifacts[0];
    const options = { root, bundledCatalog: CATALOG, confirmations: [{ root: initial.root, stepId: initialStep.id, artifactId: artifact.id, fingerprint: artifact.fingerprint, confirmedAt: new Date().toISOString() }] };
    const snapshot = await readBmadWorkflow(options);
    assert.equal(step(snapshot, 'bmad-product-brief').status, 'needs-confirmation');
    assert.equal('confirmed' in step(snapshot, 'bmad-product-brief').artifacts[0], false);
    assert.equal('canConfirm' in step(snapshot, 'bmad-product-brief').artifacts[0], false);
    assert.equal(await fs.readFile(path.join(root, '_bmad-output/planning-artifacts/brief.md'), 'utf8'), md(undefined));
    await fs.unlink(path.join(root, '_bmad-output/planning-artifacts/brief.md'));
    assert.equal(step(await read(root), 'bmad-product-brief').status, 'not-observed');
  });
});

test('config merges four TOML layers and watches custom output directories that do not exist yet', async () => {
  await fixture(async (root, write) => {
    await write('_bmad/config.toml', '[core]\noutput_folder = "_bmad-output"\n[modules.bmm]\nplanning_artifacts = "base"\n');
    await write('_bmad/config.user.toml', '[modules.bmm]\nplanning_artifacts = "personal"\n');
    await write('_bmad/custom/config.toml', '[modules.bmm]\nplanning_artifacts = "team"\n');
    await write('_bmad/custom/config.user.toml', '[modules.bmm]\nplanning_artifacts = "chosen"\nimplementation_artifacts = "future-output"\n');
    await write('chosen/prd.md', md('final'));
    const snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'complete');
    assert.ok(snapshot.watchDirectories.includes(path.join(snapshot.root!, 'chosen')));
    assert.ok(snapshot.watchDirectories.includes(path.join(snapshot.root!, 'future-output')));
    await write('_bmad/custom/config.user.toml', '[invalid');
    const invalid = await read(root);
    assert.equal(invalid.installation.state, 'error');
    assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.code === 'config-invalid'));
  });
});

test('TOML prototype keys cannot modify process prototypes and missing nested outputs watch their nearest existing ancestor', async () => {
  await fixture(async (root, write) => {
    await fs.mkdir(path.join(root, 'var'));
    await write('_bmad/config.toml', '[modules.bmm]\nplanning_artifacts = "var/build/output"\n');
    let snapshot = await read(root);
    assert.ok(snapshot.watchDirectories.includes(path.join(snapshot.root!, 'var')));
    assert.ok(snapshot.watchDirectories.includes(path.join(snapshot.root!, 'var/build/output')));
    await write('_bmad/config.toml', '[__proto__]\nbmad_polluted = "yes"\n');
    snapshot = await read(root);
    assert.equal(snapshot.installation.state, 'error');
    assert.equal(({} as Record<string, unknown>).bmad_polluted, undefined);
    assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'config-invalid'));
  });
});

test('classic sprint status and spec-centric story progress remain separate from Build completion', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/implementation-artifacts/spec-1-1-first.md', md('done'));
    await write('_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  epic-1: in-progress\n  1-1-first: review\n  1-2-second: ready-for-dev\n');
    await write('_bmad-output/specs/spec-example/stories.yaml', '- id: "S1"\n  title: Example\n  description: Example story\n');
    await write('_bmad-output/specs/spec-example/stories/S1-example.md', md('in-review'));
    const snapshot = await read(root);
    assert.equal(snapshot.stories.length, 3);
    assert.equal(snapshot.stories.find(story => story.label === '1-1-first')?.status, 'review');
    assert.equal(snapshot.stories.some(story => story.label === 'epic-1'), false);
    assert.equal(snapshot.stories.filter(story => story.mode === 'spec').length, 1);
    assert.equal(step(snapshot, 'bmad-build').artifacts.find(artifact => artifact.relativePath.endsWith('spec-1-1-first.md'))?.status, 'complete');
    assert.equal(step(snapshot, 'bmad-code-review').status, 'not-observed');
    assert.ok(snapshot.currentCandidates.some(candidate => candidate.storyId?.endsWith('#1-1-first')));
    const recommendations = snapshot.recommendations.map(item => snapshot.nodes.find(node => node.id === item.stepId)!.skill);
    assert.deepEqual(recommendations, ['bmad-code-review', 'bmad-build']);
    assert.equal(snapshot.currentCandidates.find(candidate => candidate.storyId?.endsWith('#1-1-first'))?.stepId, snapshot.nodes.find(node => node.skill === 'bmad-code-review')!.id);
    assert.equal(snapshot.currentCandidates.find(candidate => candidate.storyId?.endsWith('#S1'))?.stepId, step(snapshot, 'bmad-build').id,
      'A spec Build in-review resumes its built-in review rather than the optional extra Code Review skill');
    assert.equal(snapshot.stories.find(story => story.mode === 'spec')?.stage, 'Build 內建審查中');
  });
});

test('native Build status transitions retain work stages and a one-shot run does not invent a separate review phase', async () => {
  await fixture(async (root, write) => {
    const filename = '_bmad-output/implementation-artifacts/spec-fix.md';
    const phases = [
      ['draft', '規劃草稿'], ['ready-for-dev', '待實作'], ['in-progress', '實作中'], ['in-review', 'Build 內建審查中'], ['done', 'Build 已完成']
    ];
    for (const [status, stage] of phases) {
      await write(filename, md(status));
      const artifact = step(await read(root), 'bmad-build').artifacts[0];
      assert.equal(artifact.nativeStatus, status); assert.equal(artifact.stage, stage);
      assert.equal(artifact.status, status === 'done' ? 'complete' : 'draft');
      assert.ok(Number.isFinite(Date.parse(artifact.observedAt!)));
    }
    await write(filename, '---\nstatus: in-progress\nroute: oneshot\n---\n');
    assert.equal(step(await read(root), 'bmad-build').artifacts[0].stage, '實作與內建審查中');
    await write(filename, md('draft'));
    assert.equal(step(await read(root), 'bmad-build').artifacts[0].stage, '規劃草稿', 'A review loop can return to planning');
  });
});

test('Build aggregate keeps completed records separate from unfinished and invalid classic sprint work', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/implementation-artifacts/spec-1-1-first.md', md('done'));
    const tracking = '_bmad-output/implementation-artifacts/sprint-status.yaml';
    for (const pending of ['backlog', 'ready-for-dev', 'in-progress', 'review']) {
      await write(tracking, `development_status:\n  1-1-first: done\n  1-2-second: ${pending}\n`);
      const snapshot = await read(root); const build = step(snapshot, 'bmad-build');
      assert.equal(build.status, 'draft'); assert.equal(build.artifacts[0].status, 'complete');
      assert.match(build.summary, /1\/2 個 Story 未完成/);
      assert.equal(snapshot.stories[1].nativeStatus, pending);
      assert.ok(snapshot.stories[1].observedAt);
    }
    await write(tracking, 'development_status:\n  1-1-first: done\n  1-2-second: done\n');
    assert.equal(step(await read(root), 'bmad-build').status, 'complete');
    await write(tracking, 'development_status:\n  1-1-first: done\n  1-2-second: invented\n');
    const invalid = await read(root);
    assert.equal(step(invalid, 'bmad-build').status, 'error');
    assert.equal(invalid.stories.find(story => story.label === '1-2-second')?.status, 'error');
  });
});

test('PRFAQ native working states and completion ignore the downstream distillate companion', async () => {
  await fixture(async (root, write) => {
    const catalog = `${CATALOG}\nBMad Method,bmad-prfaq,PRFAQ,WB,Challenge,,,plan,,,false,planning_artifacts,prfaq document`;
    await write('_bmad/_config/bmad-help.csv', catalog);
    await write('_bmad-output/planning-artifacts/prfaq-example-distillate.md', '# Downstream detail pack');
    // The pinned PRFAQ references write these states, then verdict.md writes complete.
    for (const status of ['press-release', 'customer-faq', 'internal-faq', 'complete']) {
      await write('_bmad-output/planning-artifacts/prfaq-example.md', md(status));
      const snapshot = await read(root); const result = step(snapshot, 'bmad-prfaq');
      assert.equal(result.artifacts.length, 1); assert.equal(result.artifacts[0].nativeStatus, status);
      assert.equal(result.status, status === 'complete' ? 'complete' : 'draft');
      assert.equal(snapshot.diagnostics.some(item => item.code === 'artifact-status-invalid'), false);
    }
  });
});

test('canonical Brainstorm memory and spec-folder architecture and retrospective records are observed', async () => {
  await fixture(async (root, write) => {
    const catalog = `${CATALOG}\nCore,bmad-brainstorming,Brainstorm,BSP,Ideas,,,anytime,,,false,{output_folder}/brainstorming,brainstorming session\nBMad Method,bmad-retrospective,Retro,ER,Retro,,,ship,,,false,implementation_artifacts,retrospective`;
    await write('_bmad/_config/bmad-help.csv', catalog);
    await write('_bmad-output/brainstorming/session-1/.memlog.md', '---\ntopic: Example\nstatus: complete\n---\n- (insight) Chosen direction\n');
    await write('_bmad-output/specs/spec-example/SPEC.md', '# Scope');
    await write('_bmad-output/specs/spec-example/ARCHITECTURE-SPINE.md', md('final'));
    await write('_bmad-output/specs/spec-example/RETROSPECTIVE.md', '---\nverdict: rejected\ncriteria: declared\n---\n# Retrospective\n');
    const snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-brainstorming').status, 'complete');
    assert.equal(step(snapshot, 'bmad-brainstorming').artifacts[0].relativePath, '_bmad-output/brainstorming/session-1/.memlog.md');
    assert.equal(step(snapshot, 'bmad-architecture').status, 'complete');
    const retro = step(snapshot, 'bmad-retrospective');
    assert.equal(retro.artifacts.length, 1); assert.equal(retro.artifacts[0].nativeStatus, 'rejected');
    assert.equal(retro.artifacts[0].stage, '驗收未通過');
    assert.equal(retro.status, 'needs-confirmation', 'An acceptance verdict alone does not prove the retrospective workflow finished');
  });
});

test('observation timestamps do not invalidate unchanged evidence revisions', async () => {
  await fixture(async (root, write) => {
    const relative = '_bmad-output/planning-artifacts/prd.md';
    await write(relative, md('final'));
    const original = await read(root); const first = step(original, 'bmad-prd').artifacts[0];
    const touched = new Date(Date.parse(first.observedAt!) + 2000);
    await fs.utimes(path.join(root, relative), touched, touched);
    const next = await read(root);
    assert.notEqual(step(next, 'bmad-prd').artifacts[0].observedAt, first.observedAt);
    assert.equal(next.revision, original.revision);
    assert.ok(Number.isFinite(Date.parse(next.observedAt!)));
  });
});

test('bounded scans diagnose deeper unobserved outputs and flag only configured root-level artifact watching', async () => {
  await fixture(async (root, write) => {
    await write('_bmad/config.toml', '[modules.bmm]\nplanning_artifacts = "chosen"\n');
    await write('chosen/prd.md', md('final'));
    await write('chosen/one/two/three/four/five/six/prd.md', md('draft'));
    let snapshot = await read(root);
    assert.ok(snapshot.diagnostics.some(item => item.code === 'scan-depth-limit' && item.path?.endsWith('six')));
    assert.equal(snapshot.watchRootArtifacts, undefined);
    await write('_bmad/config.toml', '[modules.bmm]\nplanning_artifacts = "."\n');
    await write('prd.md', md('final'));
    snapshot = await read(root);
    assert.equal(snapshot.watchRootArtifacts, true);
    assert.equal(step(snapshot, 'bmad-prd').artifacts.length, 1, 'A root output must not recursively scan sibling repositories');
  });
});

test('recommendations honor the observed path and use BMAD Help when the path is unknown', async () => {
  await fixture(async (root, write) => {
    const withHelp = `${CATALOG}\nCore,bmad-help,Help,BH,Help,,,anytime,,,false,,`;
    await write('_bmad/_config/bmad-help.csv', withHelp);
    let snapshot = await read(root);
    assert.equal(snapshot.nodes.find(node => node.id === snapshot.recommendations[0].stepId)?.skill, 'bmad-help');
    await write('_bmad-output/specs/spec-small/stories.yaml', '- id: "1"\n  title: Example\n  description: Example story\n');
    await write('_bmad-output/specs/spec-small/stories/1-example.md', md('in-progress'));
    snapshot = await read(root);
    assert.deepEqual(snapshot.recommendations.map(item => snapshot.nodes.find(node => node.id === item.stepId)!.skill), ['bmad-build']);
    assert.equal(step(snapshot, 'bmad-prd').status, 'not-observed');
    await fs.unlink(path.join(root, '_bmad-output/specs/spec-small/stories/1-example.md'));
    await fs.unlink(path.join(root, '_bmad-output/specs/spec-small/stories.yaml'));
    await write('_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  1-1-first: backlog\n');
    snapshot = await read(root);
    assert.equal(snapshot.nodes.find(node => node.id === snapshot.recommendations[0].stepId)?.skill, 'bmad-build');
    assert.equal(snapshot.currentCandidates.some(candidate => candidate.storyId), false);
  });
});

test('invalid sprint tracking remains unknown and root outputs never scan sibling repositories', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  1-1-first: invented-state\n');
    let snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-sprint-planning').status, 'error');
    await write('_bmad/config.toml', '[modules.bmm]\nplanning_artifacts = "."\n');
    await write('prd.md', md('final'));
    await write('other-repo/prd.md', md('draft'));
    snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'complete');
    assert.equal(step(snapshot, 'bmad-prd').artifacts.length, 1);
    assert.ok(snapshot.watchDirectories.includes(snapshot.root!));
  });
});

test('a spec Story with contradictory explicit status markers remains a conflict', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/specs/spec-example/stories.yaml', '- id: "1"\n  title: Example\n  description: Example story\n');
    await write('_bmad-output/specs/spec-example/stories/1-example.md', md('done', '## Status\nin-progress\n'));
    const snapshot = await read(root);
    assert.equal(snapshot.stories[0].status, 'conflict');
    assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'story-status-conflict'));
    assert.equal(snapshot.stories.some(story => story.status === 'done'), false);
  });
});

test('official spec inventory preserves execution order and includes stories with no build record', async () => {
  await fixture(async (root, write) => {
    const prefix = '_bmad-output/specs/spec-limiter';
    // Reverse the list to prove order comes from inventory, not ids or filenames.
    const [first, second] = INVENTORY.split('- id: "2"');
    await write(`${prefix}/stories.yaml`, `- id: "2"${second}${first}`);
    await write(`${prefix}/stories/1-rate-limit.md`, md('done'));
    let snapshot = await read(root);
    assert.deepEqual(snapshot.stories.map(story => story.label), ['Expose limiter metrics to the ops dashboard', 'Add rate limiting to the public API']);
    assert.deepEqual(snapshot.stories.map(story => story.status), ['backlog', 'done']);
    assert.equal(snapshot.stories[0].association, 'not-observed');
    assert.match(snapshot.stories[0].reason, /inventory 本身沒有進度/);
    assert.equal(snapshot.stories[1].association, 'confirmed');
    const build = step(snapshot, 'bmad-build');
    assert.equal(build.artifacts.length, 1); assert.equal(build.artifacts[0].status, 'complete');
    assert.equal(build.status, 'draft'); assert.match(build.summary, /尚有 1 個/);
    assert.ok(snapshot.recommendations.some(item => item.stepId === build.id));
    await write(`${prefix}/stories/2-metrics.md`, md('done'));
    snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-build').status, 'complete');
    assert.deepEqual(snapshot.stories.map(story => story.status), ['done', 'done']);
  });
});

test('multiple records for one inventory id report ambiguity without choosing the newest', async () => {
  await fixture(async (root, write) => {
    const prefix = '_bmad-output/specs/spec-limiter';
    await write(`${prefix}/stories.yaml`, INVENTORY);
    await write(`${prefix}/stories/1-original.md`, md('done'));
    await write(`${prefix}/stories/1-newer.md`, md('draft'));
    const snapshot = await read(root);
    assert.equal(snapshot.stories[0].association, 'ambiguous');
    assert.equal(snapshot.stories[0].status, 'conflict');
    assert.match(snapshot.stories[0].reason, /1-original\.md \(done\)/);
    assert.match(snapshot.stories[0].reason, /1-newer\.md \(draft\)/);
    assert.equal(snapshot.diagnostics.filter(item => item.code === 'story-record-ambiguous').length, 2);
    assert.equal(step(snapshot, 'bmad-build').artifacts.length, 0);
    assert.equal(step(snapshot, 'bmad-build').status, 'conflict');
  });
});

test('invalid or partial inventories retain readable records with unconfirmed membership and ignore inventory status', async () => {
  await fixture(async (root, write) => {
    const prefix = '_bmad-output/specs/spec-limiter';
    await write(`${prefix}/stories/1-rate-limit.md`, md('done'));
    const invalidCases = [
      'stories:\n  - id: "1"\n    title: Wrong wrapper\n    description: Example\n',
      '- id: 1\n  title: Numeric id\n  description: Example\n',
      '- id: "1"\n  title: Forbidden status\n  description: Example\n  status: done\n',
      '- id: "1"\n  title: Duplicate\n  description: Example\n- id: "1"\n  title: Duplicate too\n  description: Example\n',
      '- id: "3"\n  title: Parent prefix\n  description: Example\n- id: "3-2"\n  title: Conflicting prefix\n  description: Example\n',
      '- id: "1"\n  title: [half-written\n'
    ];
    for (const content of invalidCases) {
      await write(`${prefix}/stories.yaml`, content);
      const snapshot = await read(root);
      assert.ok(snapshot.diagnostics.some(item => item.code === 'story-inventory-invalid'));
      assert.equal(snapshot.stories.length, 1);
      assert.equal(snapshot.stories[0].association, 'unconfirmed');
      assert.equal(snapshot.stories[0].status, 'needs-confirmation');
      assert.match(snapshot.stories[0].reason, /歸屬未確認/);
      assert.equal(step(snapshot, 'bmad-build').status, 'needs-confirmation');
      assert.equal(step(snapshot, 'bmad-build').artifacts.length, 0);
    }
  });
});

test('arbitrary stories folders are not official inventory stories and orphan records remain unconfirmed', async () => {
  await fixture(async (root, write) => {
    const prefix = '_bmad-output/specs/spec-limiter';
    await write(`${prefix}/stories/random-notes.md`, md('done'));
    assert.equal((await read(root)).stories.length, 0);
    await write(`${prefix}/stories.yaml`, INVENTORY);
    let snapshot = await read(root);
    assert.deepEqual(snapshot.stories.slice(0, 2).map(story => story.status), ['backlog', 'backlog']);
    assert.equal(snapshot.stories[2].association, 'unconfirmed');
    assert.equal(snapshot.stories[2].status, 'needs-confirmation');
    assert.equal(step(snapshot, 'bmad-build').artifacts.length, 0);
    await fs.unlink(path.join(root, prefix, 'stories.yaml'));
    await write(`${prefix}/SPEC.md`, '# Example spec');
    snapshot = await read(root);
    assert.equal(snapshot.stories[0].association, 'unconfirmed');
    assert.equal(snapshot.stories[0].status, 'needs-confirmation');
  });
});

test('invalid, oversized and half-written artifacts provide diagnostics and remain unreadable', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/prd.md', '---\nstatus: draft');
    let snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'error');
    await write('_bmad-output/planning-artifacts/prd.md', md('mystery'));
    snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'error');
    await write('_bmad-output/planning-artifacts/prd.md', md('final', 'x'.repeat(3000)));
    snapshot = await readBmadWorkflow({ root, bundledCatalog: CATALOG, maxArtifactBytes: 2500 });
    assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'read-failed'));
    assert.equal(step(snapshot, 'bmad-prd').status, 'error');
  });
});

test('external output configuration and symlink directories are not scanned', async () => {
  await fixture(async (root, write) => {
    await write('_bmad/config.toml', '[modules.bmm]\nplanning_artifacts = "../outside"\n');
    let snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').artifacts.length, 0);
    assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'output-outside-root'));
    await write('_bmad/config.toml', '[modules.bmm]\nplanning_artifacts = "linked"\n');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'bmad-test-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'prd.md'), md('final'));
      await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      snapshot = await read(root);
      assert.equal(step(snapshot, 'bmad-prd').artifacts.length, 0);
      assert.ok(snapshot.diagnostics.some(diagnostic => diagnostic.code === 'unsafe-directory'));
    } finally { assert.ok(outside.startsWith(path.join(os.tmpdir(), 'bmad-test-outside-'))); await fs.rm(outside, { recursive: true, force: true }); }
  });
});
