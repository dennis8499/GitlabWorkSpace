import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_ROOT = path.resolve(ROOT, '..', '.gitlab-workspace-validation');
const ENVIRONMENTS = {
  ce19: { url: 'http://127.0.0.1:8929', tokenName: 'GLW_CE19_TOKEN', version: '19.4.1' },
  ce16: { url: 'http://127.0.0.1:8930', tokenName: 'GLW_CE16_TOKEN', version: '16.11.10' }
};
const MARKER = 'GitLab Workspace isolated live-validation fixture';
const RUN_ID = process.env.GLW_RUN_ID || `20261006-${randomUUID().slice(0, 8)}`;
const MAX_REQUESTS = 6;
const ASK_PASS_NAME = 'gitlab-workspace-askpass.cmd';
const askPassBody = '@echo off\r\n@echo(%~1|%SystemRoot%\\System32\\findstr.exe /I "Username" >nul && (echo oauth2) || (echo %GLW_GITLAB_WORKSPACE_TEST_TOKEN%)\r\n';

class Semaphore {
  #active = 0;
  #queue = [];
  async run(operation) {
    if (this.#active >= MAX_REQUESTS) await new Promise((resolve) => this.#queue.push(resolve));
    this.#active++;
    try { return await operation(); }
    finally { this.#active--; this.#queue.shift()?.(); }
  }
}

class GitLab {
  constructor(key, token) {
    const config = ENVIRONMENTS[key];
    if (!config || !token) throw new Error('A named local GitLab environment and process token are required.');
    this.key = key;
    this.url = new URL(config.url);
    if (!['127.0.0.1', 'localhost'].includes(this.url.hostname)) throw new Error('Live validation is restricted to the two configured localhost servers.');
    this.token = token;
    this.gate = new Semaphore();
    this.metrics = { requests: 0, responseBytes: 0, failures: 0, apiMs: [] };
  }

  async request(route, { method = 'GET', body, tolerate404 = false } = {}) {
    if (route.startsWith('/') || route.includes('..')) throw new Error('A safe API-relative route is required.');
    return this.gate.run(async () => {
      const start = performance.now();
      let response;
      for (let attempt = 0; ; attempt++) {
        try {
          response = await fetch(new URL(`/api/v4/${route}`, this.url), {
            method,
            headers: { 'PRIVATE-TOKEN': this.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            redirect: 'manual', signal: AbortSignal.timeout(30_000)
          });
          break;
        } catch (error) {
          if (method === 'GET' && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
            continue;
          }
          const causeCode = error?.cause?.code ?? (error?.name === 'TimeoutError' ? 'timeout' : 'network error');
          throw new Error(`GitLab ${this.key} API ${method} ${route} failed before a response (${causeCode}).`);
        }
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      this.metrics.requests++;
      this.metrics.responseBytes += bytes.byteLength;
      this.metrics.apiMs.push(performance.now() - start);
      if (response.status === 404 && tolerate404) return undefined;
      if (response.status < 200 || response.status >= 300) {
        this.metrics.failures++;
        throw new Error(`GitLab ${this.key} API ${method} ${route} returned HTTP ${response.status}.`);
      }
      if (!bytes.length) return undefined;
      try { return JSON.parse(bytes.toString('utf8')); }
      catch { throw new Error(`GitLab ${this.key} API ${method} ${route} returned invalid JSON.`); }
    });
  }

  async pages(route) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const next = await this.request(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(next)) throw new Error(`GitLab ${this.key} returned an unexpected paged response.`);
      result.push(...next);
      if (next.length < 100) return result;
    }
    throw new Error(`GitLab ${this.key} pagination exceeded the safety limit.`);
  }

  async group(fullPath) {
    return this.request(`groups/${encodeURIComponent(fullPath)}`);
  }

  async createSubgroup(parentId, name, slug, marker) {
    const children = await this.pages(`groups/${parentId}/subgroups`);
    const found = children.find((group) => group.path === slug);
    if (found) {
      if (!String(found.description ?? '').includes(`${MARKER}; owner=${marker}`)) {
        throw new Error(`Refusing to adopt existing subgroup ${found.full_path}; its validation ownership marker does not match.`);
      }
      return { id: found.id, fullPath: found.full_path, created: false };
    }
    const group = await this.request('groups', { method: 'POST', body: {
      name, path: slug, parent_id: parentId, visibility: 'private', project_creation_level: 'maintainer',
      description: `${MARKER}; owner=${marker}`
    } });
    return { id: group.id, fullPath: group.full_path, created: true };
  }

  async createProject(groupId, name, marker) {
    const projects = await this.pages(`groups/${groupId}/projects?include_subgroups=false`);
    const found = projects.find((project) => project.path === name.toLowerCase());
    if (found) {
      if (!String(found.description ?? '').includes(`${MARKER}; owner=${marker}`)) {
        throw new Error(`Refusing to adopt existing project ${found.path_with_namespace}; its validation ownership marker does not match.`);
      }
      return { project: found, created: false };
    }
    const project = await this.request('projects', { method: 'POST', body: {
      name, path: name.toLowerCase(), namespace_id: groupId, visibility: 'private', initialize_with_readme: false,
      default_branch: 'main', description: `${MARKER}; owner=${marker}`
    } });
    return { project, created: true };
  }
}

function getEnvironmentNames(selection) {
  const names = selection === 'both' ? ['ce19', 'ce16'] : [selection];
  if (names.some((name) => !ENVIRONMENTS[name])) throw new Error('Choose --environment ce19, ce16, or both.');
  return names;
}

function manifestPath(key, runId = RUN_ID, kind = 'load') {
  return path.join(STATE_ROOT, 'runs', runId, `${key}-${kind}.json`);
}

function readManifest(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`No readable validation manifest exists at ${path.relative(ROOT, file)}.`); }
}

function writeManifest(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

function sortedPercentile(values, percent) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percent) - 1)].toFixed(2));
}

async function preflight(client) {
  const [version, user, parent] = await Promise.all([
    client.request('version'), client.request('user'), client.group('grp-sn-maint')
  ]);
  const membership = parent?.id ? await client.request(`groups/${parent.id}/members/all/${user.id}`, { tolerate404: true }) : undefined;
  const accessLevel = membership?.access_level ?? parent?.permissions?.group_access?.access_level ?? parent?.group_access?.access_level;
  const ownsGroup = parent?.owner?.id === user.id || parent?.owner === true || accessLevel === 50;
  if (!parent?.id || !ownsGroup) {
    throw new Error(`Could not verify owner access to grp-sn-maint on ${client.key} (user=${user.id}, accessLevel=${accessLevel ?? 'none'}, memberStatus=${membership ? 'found' : 'not-found'}, groupFields=${Object.keys(parent ?? {}).slice(0, 32).join(',')}); no live fixtures were written.`);
  }
  const [projects, children, issues, mergeRequests] = await Promise.all([
    client.pages(`groups/${parent.id}/projects?include_subgroups=true`),
    client.pages(`groups/${parent.id}/subgroups`),
    client.pages(`groups/${parent.id}/issues`),
    client.pages(`groups/${parent.id}/merge_requests`)
  ]);
  return {
    environment: client.key, baseUrl: client.url.origin, version: version.version,
    revision: version.revision ?? null, userId: user.id, group: parent.full_path,
    groupId: parent.id, projectCount: projects.length, childGroupCount: children.length,
    issueCount: issues.length, mergeRequestCount: mergeRequests.length,
    metrics: summarizeMetrics(client.metrics)
  };
}

function summarizeMetrics(metrics) {
  return {
    requests: metrics.requests, responseBytes: metrics.responseBytes, failures: metrics.failures,
    apiLatencyMs: { median: sortedPercentile(metrics.apiMs, 0.5), p95: sortedPercentile(metrics.apiMs, 0.95) }
  };
}

function git(args, cwd, env) {
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120_000 });
  } catch (error) {
    const code = error?.status ?? 'unknown';
    throw new Error(`Git ${args[0] ?? 'operation'} failed in an isolated validation Repo (exit ${code}).`);
  }
}

function createRepository(client, project, root, role, askPass, token, branches = []) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'README.md'), `# ${role}\n\n${MARKER}\n\nRun: ${RUN_ID}\n`, 'utf8');
  const roleFile = role === 'contracts' ? 'contract.md' : role === 'service' ? 'service.ts' : 'client.tsx';
  const body = role === 'contracts' ? '# Contract\n\nexport interface Health { ok: boolean }\n' : role === 'service' ? "export const health = () => ({ ok: true });\n" : "export function HealthView() { return <output>ok</output>; }\n";
  writeFileSync(path.join(root, roleFile), body, 'utf8');
  git(['init', '-b', 'main'], root, process.env);
  git(['config', 'user.name', 'GitLab Workspace Validation'], root, process.env);
  git(['config', 'user.email', 'gitlab-workspace-validation@example.invalid'], root, process.env);
  git(['add', '--all'], root, process.env);
  const fixedDate = '2024-01-01T00:00:00+00:00';
  const baseEnv = { ...process.env, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate };
  git(['commit', '-m', 'Add minimal validation fixture'], root, baseEnv);
  const initialSha = git(['rev-parse', 'HEAD'], root, process.env).trim();
  const remote = project.http_url_to_repo;
  if (!remote || new URL(remote).origin !== client.url.origin) throw new Error('GitLab returned a Repo URL outside the selected localhost environment.');
  git(['remote', 'add', 'origin', remote], root, process.env);
  const gitEnv = { ...process.env, GIT_ASKPASS: askPass, GIT_ASKPASS_REQUIRE: 'force', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GLW_GITLAB_WORKSPACE_TEST_TOKEN: token };
  git(['push', '--set-upstream', 'origin', 'main'], root, gitEnv);
  const branchShas = [];
  for (const branch of branches) {
    const localBranch = `validation/${RUN_ID}/${branch}`;
    git(['switch', '-c', localBranch], root, process.env);
    const file = `validation/${branch}.md`;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), `# ${branch}\n\nFixture ${RUN_ID}\n`, 'utf8');
    git(['add', file], root, process.env);
    git(['commit', '-m', `Add ${branch} validation change`], root, baseEnv);
    const sha = git(['rev-parse', 'HEAD'], root, process.env).trim();
    git(['push', 'origin', `${localBranch}:${localBranch}`], root, gitEnv);
    branchShas.push({ branch: localBranch, sha });
    git(['switch', 'main'], root, process.env);
  }
  return { initialSha, branchShas };
}

async function ensureValidationGroup(client, parent, type, slug, label, manifest) {
  const group = await client.createSubgroup(parent.id, label, slug, manifest.ownerMarker);
  if (group.created) manifest.resources.createdGroups.push({ id: group.id, fullPath: group.fullPath, slug, purpose: type });
  return group;
}

async function ensureDemo(client) {
  const file = manifestPath(client.key, 'demo', 'retained');
  let manifest;
  try { manifest = readManifest(file); }
  catch { manifest = undefined; }
  if (manifest && manifest.environment !== client.key) throw new Error('Retained demo manifest does not match the selected environment.');
  if (!manifest) manifest = {
    schema: 'GitLabWorkspaceLiveFixture/v1', environment: client.key, createdAt: new Date().toISOString(),
    ownerMarker: `demo-${client.key}`, resources: { createdGroups: [], projects: [], issues: [], mergeRequests: [], graphLinks: [] }, versions: {}
  };
  const parent = await client.group('grp-sn-maint');
  if (!parent?.id) throw new Error(`Could not resolve grp-sn-maint on ${client.key}.`);
  const validationGroup = await ensureValidationGroup(client, parent, 'demo-root', 'gitlab-workspace-live-validation', 'GitLab Workspace Live Validation', manifest);
  writeManifest(file, manifest);
  const demo = await ensureValidationGroup(client, { id: validationGroup.id }, 'demo', 'demo', 'Retained GitLab Workspace Demo', manifest);
  writeManifest(file, manifest);
  const checkoutRoot = path.join(STATE_ROOT, 'workspaces', client.key, 'demo');
  const askPass = path.join(STATE_ROOT, ASK_PASS_NAME);
  mkdirSync(path.dirname(askPass), { recursive: true });
  writeFileSync(askPass, askPassBody, 'utf8');
  for (const role of ['contracts', 'service', 'client']) {
    const { project, created } = await client.createProject(demo.id, role, manifest.ownerMarker);
    let fixture = manifest.resources.projects.find((item) => item.id === project.id);
    if (!fixture) {
      fixture = { id: project.id, path: project.path_with_namespace, role, created };
      manifest.resources.projects.push(fixture);
      writeManifest(file, manifest);
    }
    const localPath = path.join(checkoutRoot, role);
    const branch = role === 'service' ? `demo/${role}/work` : undefined;
    if (created || project.empty_repo && !existsSync(path.join(localPath, '.git'))) {
      const result = createRepository(client, project, localPath, role, askPass, client.token, branch ? [branch] : []);
      manifest.versions[role] = result.initialSha;
      fixture.initialSha = result.initialSha;
      fixture.branchShas = result.branchShas;
      writeManifest(file, manifest);
    } else {
      if (existsSync(path.join(localPath, '.git'))) {
        const oldOrigin = git(['remote', 'get-url', 'origin'], localPath, process.env).trim();
        if (oldOrigin !== project.http_url_to_repo) throw new Error(`The existing isolated ${role} workspace points to another GitLab Repo.`);
      }
      if (fixture.initialSha) manifest.versions[role] = fixture.initialSha;
      else {
        const refs = await client.request(`projects/${project.id}/repository/branches/main`);
        manifest.versions[role] = refs?.commit?.id ?? null;
      }
    }
  }
  const [contractsProject, serviceProject] = ['contracts', 'service'].map((role) => manifest.resources.projects.find((item) => item.role === role));
  if (!contractsProject || !serviceProject) throw new Error('The three retained demo Repos were not all recorded in the manifest.');
  for (const [projectFixture, title] of [[contractsProject, `Workspace demo ${client.key} contract review`], [serviceProject, `Workspace demo ${client.key} service handoff`]]) {
    if (manifest.resources.issues.some((item) => item.projectId === projectFixture.id && item.title === title)) continue;
    const existing = await client.pages(`projects/${projectFixture.id}/issues?state=all&search=${encodeURIComponent(title)}`);
    const issue = existing.find((item) => item.title === title) ?? await client.request(`projects/${projectFixture.id}/issues`, { method: 'POST', body: {
      title, description: `${MARKER}\n\nRun: retained-${client.key}\nA small cross-Repo GitLab Workspace demonstration Issue.`
    } });
    manifest.resources.issues.push({ projectId: projectFixture.id, iid: issue.iid, id: issue.id, title, webUrl: issue.web_url });
    writeManifest(file, manifest);
  }
  if (!manifest.resources.graphLinks.length) {
    const contractIssue = manifest.resources.issues.find((item) => item.projectId === contractsProject.id);
    const serviceIssue = manifest.resources.issues.find((item) => item.projectId === serviceProject.id);
    await ensureIssueLink(client, contractsProject.id, contractIssue.iid, serviceProject.id, serviceIssue.iid, manifest);
    writeManifest(file, manifest);
  }
  const serviceBranch = serviceProject.branchShas?.[0]?.branch ?? 'demo/service/work';
  if (!manifest.resources.mergeRequests.length) {
    const existing = await client.pages(`projects/${serviceProject.id}/merge_requests?state=all&source_branch=${encodeURIComponent(serviceBranch)}`);
    const mergeRequest = existing.find((item) => item.source_branch === serviceBranch && item.target_branch === 'main') ?? await client.request(`projects/${serviceProject.id}/merge_requests`, { method: 'POST', body: {
      title: `Workspace demo ${client.key} handoff`, description: `${MARKER}\n\nRun: retained-${client.key}\nReview the small service handoff change.`,
      source_branch: serviceBranch, target_branch: 'main', remove_source_branch: false
    } });
    manifest.resources.mergeRequests.push({ projectId: serviceProject.id, iid: mergeRequest.iid, id: mergeRequest.id, title: mergeRequest.title, webUrl: mergeRequest.web_url });
    writeManifest(file, manifest);
  }
  manifest.group = demo;
  manifest.checkoutRoot = checkoutRoot;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(file, manifest);
  return { path: file, manifest };
}

async function createIssue(client, projectId, title, description, manifest, bucket) {
  const recorded = manifest.resources[bucket].find((item) => item.projectId === projectId && item.title === title);
  let issue = recorded ? await client.request(`projects/${projectId}/issues/${recorded.iid}`) : undefined;
  if (!issue) {
    const existing = await client.pages(`projects/${projectId}/issues?state=all&search=${encodeURIComponent(title)}`);
    issue = existing.find((item) => item.title === title);
  }
  if (!issue) issue = await client.request(`projects/${projectId}/issues`, { method: 'POST', body: { title, description } });
  if (!manifest.resources[bucket].some((item) => item.projectId === projectId && item.iid === issue.iid)) {
    manifest.resources[bucket].push({ projectId, iid: issue.iid, id: issue.id, title: issue.title, webUrl: issue.web_url });
  }
  return issue;
}

async function ensureIssueLink(client, projectId, sourceIid, targetProjectId, targetIid, manifest) {
  const recorded = manifest.resources.graphLinks.find((item) => item.projectId === projectId && item.sourceIid === sourceIid &&
    (item.targetProjectId ?? projectId) === targetProjectId && item.targetIid === targetIid);
  if (recorded) return recorded;
  const links = await client.pages(`projects/${projectId}/issues/${sourceIid}/links`);
  const existing = links.find((item) => item.target_project_id === targetProjectId && item.target_issue_iid === targetIid);
  const link = existing ?? await client.request(`projects/${projectId}/issues/${sourceIid}/links`, { method: 'POST', body: {
    target_project_id: targetProjectId, target_issue_iid: targetIid, link_type: 'relates_to'
  } });
  const entry = { projectId, sourceIid, targetProjectId, targetIid, id: link?.id ?? null };
  manifest.resources.graphLinks.push(entry);
  return entry;
}

async function setupLoad(client, runId) {
  const file = manifestPath(client.key, runId, 'load');
  let manifest;
  try { manifest = readManifest(file); }
  catch { manifest = undefined; }
  if (manifest?.cleanedAt) {
    manifest.createdAt = new Date().toISOString();
    manifest.resources = { createdGroups: [], projects: [], issues: [], mergeRequests: [], graphLinks: [] };
    delete manifest.group;
    delete manifest.graphProject;
    delete manifest.cleanedAt;
  }
  if (!manifest) manifest = {
    schema: 'GitLabWorkspaceLiveFixture/v1', environment: client.key, runId, createdAt: new Date().toISOString(),
    ownerMarker: `load-${runId}-${client.key}`, resources: { createdGroups: [], projects: [], issues: [], mergeRequests: [], graphLinks: [] },
    targetCounts: { projects: 20, issues: 500, mergeRequests: 50, graphNodes: 200 }
  };
  if (manifest.environment !== client.key || manifest.runId !== runId) throw new Error('Load manifest identity does not match the selected environment and run ID.');
  const parent = await client.group('grp-sn-maint');
  const load = await ensureValidationGroup(client, parent, 'performance', `performance-${runId}`, `GitLab Workspace Performance ${runId}`, manifest);
  manifest.group = load;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(file, manifest);
  const askPass = path.join(STATE_ROOT, ASK_PASS_NAME);
  mkdirSync(path.dirname(askPass), { recursive: true });
  writeFileSync(askPass, askPassBody, 'utf8');
  const workRoot = path.join(STATE_ROOT, 'workspaces', client.key, runId, 'performance');
  mkdirSync(workRoot, { recursive: true });
  const projects = [];
  for (let i = 1; i <= 20; i++) {
    const name = `load-${runId}-${String(i).padStart(2, '0')}`;
    const { project, created } = await client.createProject(load.id, name, manifest.ownerMarker);
    projects.push(project);
    if (!manifest.resources.projects.some((item) => item.id === project.id)) {
      manifest.resources.projects.push({ id: project.id, path: project.path_with_namespace, created });
      writeManifest(file, manifest);
    }
    const fixture = manifest.resources.projects.find((item) => item.id === project.id);
    if (created || project.empty_repo) {
      const mrBranches = Array.from({ length: i <= 10 ? 3 : 2 }, (_, n) => `mr-${i}-${n + 1}`);
      const seeded = createRepository(client, project, path.join(workRoot, name), 'service', askPass, client.token, mrBranches);
      fixture.initialSha = seeded.initialSha;
      fixture.branchShas = seeded.branchShas;
      writeManifest(file, manifest);
    }
    for (const branch of fixture.branchShas ?? []) {
      const recorded = manifest.resources.mergeRequests.find((item) => item.projectId === project.id && item.sourceBranch === branch.branch);
      if (recorded) continue;
      const existing = await client.pages(`projects/${project.id}/merge_requests?state=all&source_branch=${encodeURIComponent(branch.branch)}`);
      const mr = existing.find((item) => item.source_branch === branch.branch && item.target_branch === 'main') ?? await client.request(`projects/${project.id}/merge_requests`, { method: 'POST', body: {
        title: `Validation ${branch.branch}`, description: `${MARKER}\n\nRun: ${runId}`, source_branch: branch.branch,
        target_branch: 'main', remove_source_branch: false
      } });
      if (!manifest.resources.mergeRequests.some((item) => item.projectId === project.id && item.iid === mr.iid)) {
        manifest.resources.mergeRequests.push({ projectId: project.id, iid: mr.iid, id: mr.id, sourceBranch: branch.branch, webUrl: mr.web_url });
      }
      writeManifest(file, manifest);
    }
  }
  const issueWork = [];
  for (const project of projects) for (let index = 1; index <= 25; index++) {
    const ordinal = issueWork.length + 1;
    issueWork.push(() => createIssue(client, project.id, `Validation ${runId} issue ${String(ordinal).padStart(3, '0')}`,
      `${MARKER}\n\nRun: ${runId}\nFixture issue ${ordinal}.`, manifest, 'issues'));
  }
  for (let offset = 0; offset < issueWork.length; offset += MAX_REQUESTS) {
    await Promise.all(issueWork.slice(offset, offset + MAX_REQUESTS).map((operation) => operation()));
    writeManifest(file, manifest);
  }
  const graphProjectName = `graph-${runId}`;
  const { project: graphProject, created: graphProjectCreated } = await client.createProject(load.id, graphProjectName, manifest.ownerMarker);
  if (!manifest.resources.projects.some((item) => item.id === graphProject.id)) manifest.resources.projects.push({ id: graphProject.id, path: graphProject.path_with_namespace, created: graphProjectCreated, graph: true });
  const graphIssues = [];
  for (let offset = 0; offset < 200; offset += MAX_REQUESTS) {
    const batch = await Promise.all(Array.from({ length: Math.min(MAX_REQUESTS, 200 - offset) }, (_, inner) => {
      const ordinal = offset + inner + 1;
      return createIssue(client, graphProject.id, `Graph ${runId} node ${String(ordinal).padStart(3, '0')}`,
        `${MARKER}\n\nRun: ${runId}\nGraph node ${ordinal}.`, manifest, 'issues');
    }));
    graphIssues.push(...batch);
    writeManifest(file, manifest);
  }
  for (let offset = 0; offset < graphIssues.length - 1; offset += MAX_REQUESTS) {
    const edges = graphIssues.slice(offset, Math.min(graphIssues.length - 1, offset + MAX_REQUESTS)).map((issue, inner) => {
      const next = graphIssues[offset + inner + 1];
      return ensureIssueLink(client, graphProject.id, issue.iid, graphProject.id, next.iid, manifest);
    });
    await Promise.all(edges);
    writeManifest(file, manifest);
  }
  manifest.group = load;
  manifest.graphProject = { id: graphProject.id, path: graphProject.path_with_namespace, nodeCount: graphIssues.length, edgeCount: manifest.resources.graphLinks.length };
  manifest.updatedAt = new Date().toISOString();
  manifest.metrics = summarizeMetrics(client.metrics);
  writeManifest(file, manifest);
  return { file, manifest };
}

async function cleanupLoad(client, runId) {
  const file = manifestPath(client.key, runId, 'load');
  const manifest = readManifest(file);
  const recordedGroup = manifest.group?.id ? manifest.group : manifest.resources?.createdGroups?.find((item) =>
    item.purpose === 'performance' && item.slug === `performance-${runId}` && item.fullPath === `grp-sn-maint/performance-${runId}`);
  if (manifest.schema !== 'GitLabWorkspaceLiveFixture/v1' || manifest.environment !== client.key || manifest.runId !== runId || !recordedGroup?.id) {
    throw new Error('The load manifest failed environment, run ID, or ownership validation; nothing was deleted.');
  }
  const group = await client.request(`groups/${recordedGroup.id}`, { tolerate404: true });
  if (!group) { rmSync(file, { force: true }); return { deleted: false, alreadyGone: true, file }; }
  if (group.full_path !== recordedGroup.fullPath || !String(group.description ?? '').includes(`${MARKER}; owner=${manifest.ownerMarker}`)) {
    throw new Error('The live load group no longer matches its exact manifest identity and ownership marker; nothing was deleted.');
  }
  await client.request(`groups/${group.id}`, { method: 'DELETE' });
  manifest.group = recordedGroup;
  manifest.cleanedAt = new Date().toISOString();
  writeManifest(file, manifest);
  return { deleted: true, group: group.full_path, file };
}

async function verify(client, kind, runId) {
  const file = manifestPath(client.key, kind === 'demo' ? 'demo' : runId, kind === 'demo' ? 'retained' : 'load');
  const manifest = readManifest(file);
  if (manifest.environment !== client.key) throw new Error('Manifest environment does not match the selected server.');
  const projects = [];
  for (const fixture of manifest.resources.projects) {
    const project = await client.request(`projects/${fixture.id}`);
    if (project.path_with_namespace !== fixture.path) throw new Error(`Fixture Repo identity changed for project ${fixture.id}.`);
    projects.push({ id: project.id, path: project.path_with_namespace, empty: project.empty_repo, defaultBranch: project.default_branch ?? null });
  }
  const issues = [];
  for (const fixture of manifest.resources.issues.slice(0, 10)) {
    const issue = await client.request(`projects/${fixture.projectId}/issues/${fixture.iid}`);
    issues.push({ id: issue.id, iid: issue.iid, state: issue.state });
  }
  return {
    environment: client.key, version: manifest.version ?? ENVIRONMENTS[client.key].version,
    group: manifest.group?.fullPath, projects, verifiedIssueCount: issues.length, issueCount: manifest.resources.issues.length,
    mergeRequestCount: manifest.resources.mergeRequests?.length ?? 0, graph: manifest.graphProject ?? null,
    metrics: summarizeMetrics(client.metrics)
  };
}

async function main() {
  const [command = 'preflight', ...args] = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const environments = getEnvironmentNames(option('--environment', 'both'));
  const runId = option('--run-id', RUN_ID);
  if (!/^[a-z0-9][a-z0-9-]{3,39}$/.test(runId)) throw new Error('Run IDs may contain only 4–40 lowercase letters, digits, and hyphens.');
  const output = [];
  for (const key of environments) {
    const token = process.env[ENVIRONMENTS[key].tokenName];
    if (!token) throw new Error(`Set ${ENVIRONMENTS[key].tokenName} in the test process environment to use ${key}.`);
    const client = new GitLab(key, token);
    let result;
    if (command === 'preflight') result = await preflight(client);
    else if (command === 'setup-demo') result = await ensureDemo(client);
    else if (command === 'setup-load') result = await setupLoad(client, runId);
    else if (command === 'cleanup-load') result = await cleanupLoad(client, runId);
    else if (command === 'verify-demo') result = await verify(client, 'demo', runId);
    else if (command === 'verify-load') result = await verify(client, 'load', runId);
    else throw new Error('Use preflight, setup-demo, setup-load, cleanup-load, verify-demo, or verify-load.');
    output.push({ ...result, command });
    client.token = '';
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Live validation failed.';
  const redacted = Object.values(ENVIRONMENTS).reduce((value, config) => {
    const token = process.env[config.tokenName];
    return token ? value.split(token).join('[redacted]') : value;
  }, message);
  process.stderr.write(`${redacted}\n`);
  process.exitCode = 1;
}).finally(() => {
  process.env.GLW_CE19_TOKEN = '';
  process.env.GLW_CE16_TOKEN = '';
});
