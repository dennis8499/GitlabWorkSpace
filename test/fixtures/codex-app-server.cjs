// Offline protocol peer. Routing modes only write their temporary test session.
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const root = process.argv[2];
const mode = process.argv[3];
let initialized = false, sequence = 0, active, pending = [];
let goal, selectedModelLost = false;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
function complete(status = 'completed') {
  if (active && mode.startsWith('evolution')) fs.writeFileSync(path.join(root, 'fixture-turn.json'), JSON.stringify({ id: active.turnId, status, items: [] }));
  if (active) notify('turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status, items: [], error: null } });
}
function next() {
  const request = pending.shift();
  if (request) {
    const message = { id: request.id, method: request.method, params: { threadId: active.threadId, turnId: active.turnId, ...request.params } };
    send(message); if (mode === 'duplicate-approval' && request.id === 91) send(message);
  }
  else complete();
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  if (!method) {
    if (mode === 'exit-after-approval') process.exit(5);
    notify('serverRequest/resolved', { threadId: active.threadId, requestId: id }); next(); return;
  }
  if (method === 'initialize') { send({ id, result: { userAgent: 'offline-test', platformFamily: 'windows' } }); return; }
  if (method === 'initialized') { initialized = true; return; }
  if (!initialized) { send({ id, error: { code: -32000, message: 'Not initialized' } }); return; }
  if (method === 'test/echo') { setTimeout(() => send({ id, result: params }), params.delay ?? 0); return; }
  if (method === 'test/agent-response') {
    send({ id, result: {} });
    notify('item/agentMessage/delta', { ...active, itemId: 'actual-agent', delta: 'Actual delayed response' }); return;
  }
  if (method === 'test/ignore') return;
  if (method === 'test/exit') { process.exit(3); }
  if (method === 'test/bad-json') { process.stdout.write('{bad\n'); return; }
  if (method === 'test/error') { send({ id, error: { code: -32600, message: 'SECRET that must not reach the UI' } }); return; }
  if (method === 'test/split') {
    const data = Buffer.from(JSON.stringify({ id, result: { text: '中文輸出' } }) + '\n');
    const split = data.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(data.subarray(0, split)); setTimeout(() => process.stdout.write(data.subarray(split)), 3); return;
  }
  if (method === 'account/read') { send({ id, result: { account: mode === 'logged-out' ? null : { type: 'chatgpt' }, requiresOpenaiAuth: true } }); return; }
  if (method === 'windowsSandbox/readiness') { send({ id, result: { status: mode === 'sandbox-missing' ? 'notConfigured' : 'ready' } }); return; }
  if (method === 'configRequirements/read') { send({ id, result: { requirements: mode === 'managed' ? { allowedSandboxModes: ['read-only'] } : null } }); return; }
  if (mode.startsWith('evolution') && method === 'account/rateLimits/read') { send({ id, result: { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 12, resetsAt: 1794000000 } } } }); return; }
  if (mode.startsWith('evolution') && method === 'mcpServerStatus/list') { send({ id, result: { data: [{ name: 'fixture', authStatus: 'ready' }] } }); return; }
  if (mode.startsWith('evolution') && method === 'thread/fork') { send({ id, result: { thread: { id: 'fork-' + params.threadId } } }); return; }
  if (mode.startsWith('evolution') && method === 'thread/goal/get') { send({ id, result: { goal } }); return; }
  if (mode.startsWith('evolution') && method === 'thread/goal/clear') { goal = undefined; send({ id, result: {} }); return; }
  if (mode.startsWith('evolution') && method === 'thread/goal/set') {
    goal = { ...goal, ...params, tokensUsed: 12 }; send({ id, result: { goal } }); notify('thread/goal/updated', { threadId: params.threadId, goal });
    if (mode === 'evolution-goal' && params.status === 'active') setTimeout(() => {
      active.turnId = 'goal-continuation'; notify('turn/started', { threadId: active.threadId, turn: { id: active.turnId } });
      notify('item/agentMessage/delta', { ...active, itemId: 'continuation', delta: 'Native goal continuation' });
      goal.status = 'complete'; notify('thread/goal/updated', { threadId: params.threadId, goal });
      setTimeout(() => complete(), 30);
    }, 60);
    return;
  }
  if (method === 'skills/list') {
    const result = { data: [{ cwd: root, skills: ['codebase-wiki', 'merge-reviewer', 'release-reviewer', 'model-routing'].map(name => ({ name, path: path.join(root, '.agents/skills', name, 'SKILL.md'), enabled: true })) }] };
    const held = path.join(root, 'fixture-held-setup');
    if (mode === 'hold-before-turn' && !fs.existsSync(held)) { fs.writeFileSync(held, '1'); setTimeout(() => send({ id, result }), 1000); }
    else send({ id, result });
    return;
  }
  if (method === 'skills/extraRoots/set') { send({ id, result: {} }); return; }
  if (method === 'model/list') {
    const efforts = mode === 'routing-max-missing' ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(root, 'fixture-routing.json'), 'utf8')); } catch {}
    const additional = config?.model && config.model !== 'gpt-6-luna' && !selectedModelLost ? [{ id: config.model, model: config.model,
      displayName: config.model, supportedReasoningEfforts: config.supportedEfforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }] : [];
    send({ id, result: { data: mode === 'routing-model-missing' || mode === 'routing-page' && !params.cursor ? [] : [
      { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }, ...additional
    ], nextCursor: mode === 'routing-page' && !params.cursor ? 'second' : null } }); return;
  }
  if (method === 'thread/start') { send({ id, result: { thread: { id: 'thread-' + ++sequence } } }); return; }
  if (method === 'thread/resume') { send({ id, result: { thread: { id: params.threadId } } }); return; }
  if (method === 'thread/turns/list') {
    if (mode.startsWith('evolution') && fs.existsSync(path.join(root, 'fixture-turn.json'))) { send({ id, result: { data: [JSON.parse(fs.readFileSync(path.join(root, 'fixture-turn.json'), 'utf8'))], nextCursor: null } }); return; }
    const page = params.cursor ? 'earlier' : 'latest';
    send({ id, result: { data: mode === 'empty-thread' ? [] : mode === 'paged-history'
      ? [{ id: page, status: 'completed', items: [{ id: page, type: 'agentMessage', text: page }] }]
      : [{ id: 'old-turn', items: [{ id: 'old-message', type: 'agentMessage', text: '先前已保存的結果' }] }],
    nextCursor: mode === 'paged-history' ? params.cursor ? 'oldest' : 'older' : null } }); return;
  }
  if (method === 'turn/start') {
    active = { threadId: params.threadId, turnId: 'turn-' + ++sequence };
    send({ id, result: { turn: { id: active.turnId, status: 'inProgress', items: [] } } });
    notify('turn/started', { threadId: active.threadId, turn: { id: active.turnId } });
    const prompt = params.input[0].text;
    if (mode === 'startup-user-echo') {
      notify('item/started', { ...active, item: { id: 'user-echo', type: 'userMessage', content: [{ type: 'inputText', text: prompt }] } }); return;
    }
    if (mode.startsWith('evolution')) {
      notify('turn/plan/updated', { ...active, plan: [{ step: 'Inspect', status: 'inProgress' }] });
      notify('turn/diff/updated', { ...active, diff: '--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new' });
      notify('thread/tokenUsage/updated', { ...active, tokenUsage: { total: { totalTokens: 10, inputTokens: 6, outputTokens: 4 } } });
    }
    if (prompt.includes('drop-response')) { process.exit(4); }
    notify('item/agentMessage/delta', { ...active, itemId: 'agent-1', delta: '處理中' });
    if (prompt.includes('routing_adapter=workbench')) {
      if (mode === 'routing-hold') return;
      const config = JSON.parse(fs.readFileSync(path.join(root, 'fixture-routing.json'), 'utf8'));
      const statePath = path.join(config.runtimeRoot, 'routing', config.tool, config.requestId + '.json');
      const jobPath = path.join(config.runtimeRoot, 'jobs', config.requestId + '.json');
      const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
      const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
      const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
        schema: config.model ? 'ReviewModelRouting/v2' : 'ReviewModelRouting/v1', tool: config.tool, request_id: config.requestId, runtime_root: config.runtimeRoot,
        context_dir: job.context_dir, input_digest: job.input_digest, snapshot_hash: 'a'.repeat(64),
        requested_effort: config.requestedEffort, model: config.model ?? 'gpt-6-luna', ...(config.model ? { supported_efforts: config.supportedEfforts } : {}), effort: null, phase: 'routing', reason: '', checkpoint: '', history: [], revision: 0
      };
      const heldReview = path.join(root, 'fixture-held-review');
      if (mode === 'routing-hold-review' && prompt.includes('routing_phase=review') && !fs.existsSync(heldReview)) {
        state.effort ??= config.requestedEffort; state.phase = 'reviewing'; state.revision++;
        state.history.push({ effort: state.effort, reason: 'User-selected effort.', kind: 'manual' });
        write(statePath, state); write(heldReview, true); return;
      }
      if (mode !== 'routing-no-decision') {
        if (prompt.includes('routing_phase=assess')) {
          if (config.model) { state.recommended_effort = config.recommended ?? config.initialEffort ?? 'high'; state.capped = config.capped ?? false; }
          if (mode === 'routing-selected-removed') selectedModelLost = true;
          state.effort = config.initialEffort ?? 'high'; state.phase = 'reviewing'; state.reason = 'Fixed API behavior.';
          state.history.push({ effort: state.effort, reason: state.reason, kind: 'decide' }); state.revision++;
        } else if (config.escalate && state.effort !== config.escalate) {
          state.effort = config.escalate; state.phase = 'reviewing'; state.reason = 'New frozen consumer risk.';
          state.checkpoint = 'Recheck the affected contract before continuing.';
          state.history.push({ effort: state.effort, reason: state.reason, kind: 'escalate' }); state.revision++;
        } else if (mode !== 'routing-incomplete') {
          state.effort ??= config.requestedEffort;
          if (!state.history.length) state.history.push({ effort: state.effort, reason: 'User-selected effort.', kind: 'manual' });
          state.phase = 'complete'; state.revision++; state.report_path = path.join(root, 'review-reports', config.tool + '.md');
          write(jobPath, { ...job, state: 'published', report_path: state.report_path });
        }
        write(statePath, state);
      }
      if (!(mode === 'routing-hold-assess' && prompt.includes('routing_phase=assess'))) setTimeout(() => complete(), 30);
      return;
    }
    if (prompt.includes('unknown-request')) {
      send({ id: 'unknown', method: 'item/tool/call', params: { ...active, name: 'unsupported' } }); return;
    }
    if (prompt.includes('auto-approvals')) {
      pending = [
        { id: 91, method: 'item/commandExecution/requestApproval', params: { command: 'git status', cwd: root, availableDecisions: mode === 'no-single-approval' ? ['decline', 'cancel'] : ['accept', 'decline'] } },
        { id: 92, method: 'item/commandExecution/requestApproval', params: { networkApprovalContext: { host: 'example.test', protocol: 'https' } } },
        { id: 93, method: 'item/commandExecution/requestApproval', params: { command: 'write_stdin', cwd: root } },
        { id: 94, method: 'item/fileChange/requestApproval', params: { grantRoot: root } },
        { id: 95, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } },
        { id: 96, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: 'Choose a plan', options: [{ label: 'A' }, { label: 'B' }] }] } },
        { id: 97, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'MCP form', requestedSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        { id: 98, method: 'mcpServer/elicitation/request', params: { mode: 'url', url: 'https://example.test/auth', message: 'Sign in' } }
      ]; next(); return;
    }
    if (prompt.includes('interactive')) {
      pending = [
        { id: 91, method: 'item/commandExecution/requestApproval', params: { command: 'git status', cwd: root } },
        { id: 'file-92', method: 'item/fileChange/requestApproval', params: { grantRoot: root } },
        { id: 93, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } },
        { id: 94, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'choice', question: '選擇哪個？', options: [{ label: 'A' }, { label: 'B' }] }] } },
        { id: 95, method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'test', message: '填寫資料', requestedSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
        { id: 96, method: 'mcpServer/elicitation/request', params: { mode: 'url', serverName: 'test', url: 'https://example.test/auth', message: '登入工具' } }
      ]; next(); return;
    }
    if (!prompt.includes('hold') || prompt.includes('原始任務（先核對已完成進度')) setTimeout(() => complete(), 30);
    return;
  }
  if (method === 'turn/steer') { send({ id, result: { turnId: active.turnId } }); complete(); return; }
  if (method === 'turn/interrupt') { send({ id, result: {} }); complete('interrupted'); return; }
  send({ id, error: { code: -32601, message: 'unknown method' } });
});
rl.once('close', () => process.exit(0));
