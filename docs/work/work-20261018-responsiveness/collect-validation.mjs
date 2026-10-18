import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(root, '.gitlab-workspace-validation/optimization');
const target = path.join(base, process.env.GLW_REPORT_VALIDATION_RUN ?? 'final-validation-7');
const load = name => JSON.parse(readFileSync(path.join(base, name, 'timings.json'), 'utf8'));
const phasePrefix = process.env.GLW_VALIDATION_PHASE_PREFIX ?? 'final3';
const jobs = [
  [process.env.GLW_PREPARATION_RUN ?? 'final6-prepare', () => true],
  ['final-unit', () => true],
  [`${phasePrefix}-behavior`, () => true],
  [`${phasePrefix}-extension`, () => true],
  ['final-validation-4', stage => stage.id.startsWith('release-')],
  [process.env.GLW_PACKAGE_RUN ?? 'final4-package', () => true]
];
mkdirSync(target, { recursive: true });
const records = [], sourceRuns = [];
for (const [name, select] of jobs) {
  const run = load(name), selected = run.stages.filter(select);
  if (!selected.length || selected.some(stage => stage.exitCode !== 0) || name !== 'final-validation-4' && !run.success) throw new Error(`Validation phase is incomplete or failed: ${name}`);
  if (name === 'final-validation-4') {
    const expected = ['release-tooling', ...readdirSync(path.join(root, 'test/release')).filter(name => name.endsWith('_test.py')).map(name => `release-${name.replace('_test.py', '')}`)];
    if (expected.some(id => !selected.some(stage => stage.id === id))) throw new Error('Required toolkit release regressions are missing.');
  }
  sourceRuns.push({ name, originalStatus: run.status, selectedStages: selected.map(stage => stage.id) });
  for (const stage of selected) {
    const log = path.join(target, `${stage.id}.log`);
    copyFileSync(stage.log, log);
    records.push({ ...stage, originalLog: stage.log, log, sourceRun: name });
  }
}
const kit = path.join(root, 'resources/offline-tools/workflow-kit.tar.xz');
const kitSha = createHash('sha256').update(readFileSync(kit)).digest('hex');
const previousKitBuild = readFileSync(path.join(base, 'final-validation-4/build-kit.log'), 'utf8');
if (!previousKitBuild.includes(`"sha256": "${kitSha}"`)) throw new Error('The toolkit changed after its release checks; rerun its release checks.');
const equivalenceFile = path.join(root, 'docs/work/work-20261018-responsiveness/evidence/fixture-artifact-equivalence.json');
const equivalence = JSON.parse(readFileSync(equivalenceFile, 'utf8'));
const artifactSha = createHash('sha256').update(readFileSync(path.join(root, 'dist/gitlab-workspace-0.26.0-responsiveness-candidate.vsix'))).digest('hex');
if (equivalence.schema !== 'GitLabWorkspaceArtifactEquivalence/v1' || equivalence.status !== 'PASS' || equivalence.artifact?.sha256 !== artifactSha
  || !equivalence.checkedFiles || equivalence.checked?.length !== equivalence.checkedFiles || !Array.isArray(equivalence.mismatches) || equivalence.mismatches.length
  || !Array.isArray(equivalence.normalizedFiles) || equivalence.normalizedFiles.some(value => value.path !== 'readme.md'
    || value.normalization !== 'VSCE relative documentation links to repository blob/HEAD URLs')) throw new Error('Native fixture rebuild equivalence evidence is missing, incomplete or does not match the delivered VSIX.');
const report = { schema: 'GitLabWorkspaceCompositeValidation/v1', generatedAt: new Date().toISOString(),
  status: 'success', success: true, seconds: Math.round(records.reduce((total, stage) => total + stage.seconds, 0) * 1000) / 1000,
  durationMeaning: 'Sum of selected stage durations, including the two parallel toolkit workers; not wall-clock elapsed time.',
  methodology: 'The final3 behavior and native Host checks cover the final product source, including internal-note draft preservation, cancel-edit restoration, VirtualRows keyboard focus and reduced measurement work for small-list search. A later first-feedback navigation harness defect omitted BMAD from its button-index order; the corrected harness selects visible labels and asserts completed host.activeMode equals the destination. Product source did not change for that correction; final4-package remains the delivered artifact. Native fixture observations were then corrected without product changes and recompiled in final6-prepare. Every extension/ file in the preserved VSIX was compared with the rebuilt workspace: runtime files and resources are byte-identical, with only the documented deterministic VSCE README-link transformation allowed. The equivalence report and delivered VSIX SHA256 must match before collection; container metadata is excluded. The interrupted baseline and two unsuccessful native observation attempts remain incomplete/failed historical evidence. Accepted native graph runs independently prove the original iframe target disappears after hide, a new target/context/Blob Worker restores finite positions, and unmount terminates its Workers. The unchanged product retains final3 behavior/Host checks. Historical warm-navigation/search paths already used labels, so the observed +11.111% search FAIL is retained and is not attributed to the first-feedback selector bug. Unchanged backend modules retain the successful 497-unit checks from final-unit; unchanged toolkit inputs retain all release checks from final-validation-4, with the toolkit archive SHA256 checked before reuse. Historical failures remain separate from final delivery evidence and do not establish a proven performance root cause.',
  artifactEquivalence: { evidence: path.relative(root, equivalenceFile).replaceAll('\\', '/'), status: equivalence.status,
    artifact: equivalence.artifact, checkedFiles: equivalence.checkedFiles, normalizedFiles: equivalence.normalizedFiles },
  toolkitSha256: kitSha, sourceRuns, stages: records };
writeFileSync(path.join(target, 'timings.json'), JSON.stringify(report, null, 2) + '\n');
copyFileSync(path.join(root, '.gitlab-workspace-validation/prepared.json'), path.join(target, 'prepared.json'));
console.log(JSON.stringify({ success: true, stages: records.length, target }, null, 2));
