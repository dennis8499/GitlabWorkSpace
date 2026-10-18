import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BmadReadCache, createBmadConfirmation, parseBmadCatalog, readBmadWorkflow, revokeBmadConfirmation } from '../../src/workspace/bmadWorkflow';
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

test('absent and unsupported installations still expose the complete bundled catalog', async () => {
  await fixture(async (root, write) => {
    await write('_bmad/_config/manifest.yaml', 'installation:\n  version: 7.0.0\n');
    await write('_bmad-output/planning-artifacts/prd.md', md('final'));
    const snapshot = await read(root);
    assert.equal(snapshot.installation.state, 'unsupported');
    assert.equal(snapshot.catalogSource, 'bundled');
    assert.equal(step(snapshot, 'bmad-prd').status, 'not-observed');
  });
});

test('file existence and stepsCompleted never imply final completion', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/prd.md', '---\nstepsCompleted: [1, 2, 3, 4, 99]\nstatus: draft\n---\n');
    const snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'draft');
    assert.equal(step(snapshot, 'bmad-prd').artifacts[0].canConfirm, false);
    const artifact = step(snapshot, 'bmad-prd').artifacts[0];
    assert.throws(() => createBmadConfirmation(snapshot, { revision: snapshot.revision, stepId: step(snapshot, 'bmad-prd').id, artifactId: artifact.id }), /不可覆寫/);
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

test('manual confirmation is artifact-scoped, revision-checked and invalidated by any content change', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/brief.md', md(undefined));
    let snapshot = await read(root); const initialStep = step(snapshot, 'bmad-product-brief'); const artifact = initialStep.artifacts[0];
    const request = { revision: snapshot.revision, stepId: initialStep.id, artifactId: artifact.id };
    assert.throws(() => createBmadConfirmation(snapshot, { ...request, revision: 'stale' }), /已變更/);
    const confirmation = createBmadConfirmation(snapshot, request, new Date('2026-10-17T00:00:00Z'));
    snapshot = await readBmadWorkflow({ root, bundledCatalog: CATALOG, confirmations: [confirmation] });
    assert.equal(step(snapshot, 'bmad-product-brief').status, 'complete');
    assert.equal(step(snapshot, 'bmad-product-brief').artifacts[0].confirmed, true);
    assert.deepEqual(revokeBmadConfirmation([confirmation], snapshot.root!, initialStep.id, artifact.id), []);
    await write('_bmad-output/planning-artifacts/brief.md', 'Changed content');
    snapshot = await readBmadWorkflow({ root, bundledCatalog: CATALOG, confirmations: [confirmation] });
    assert.equal(step(snapshot, 'bmad-product-brief').status, 'needs-confirmation');
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

test('invalid sprint tracking cannot be manually confirmed and root outputs never scan sibling repositories', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/implementation-artifacts/sprint-status.yaml', 'development_status:\n  1-1-first: invented-state\n');
    let snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-sprint-planning').status, 'error');
    assert.equal(step(snapshot, 'bmad-sprint-planning').artifacts[0].canConfirm, false);
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

test('invalid, oversized and half-written artifacts provide diagnostics and cannot be manually completed', async () => {
  await fixture(async (root, write) => {
    await write('_bmad-output/planning-artifacts/prd.md', '---\nstatus: draft');
    let snapshot = await read(root);
    assert.equal(step(snapshot, 'bmad-prd').status, 'error');
    assert.equal(step(snapshot, 'bmad-prd').artifacts[0].canConfirm, false);
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
