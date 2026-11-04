// Offline protocol peer. It never runs commands, edits projects, or calls a model.
const readline = require('node:readline');
const path = require('node:path');
const root = process.argv[2];
const mode = process.argv[3];
let initialized = false, sequence = 0, active, pending = [];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
function complete(status = 'completed') {
  if (active) notify('turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status, items: [], error: null } });
}
function next() {
  const request = pending.shift();
  if (request) send({ id: request.id, method: request.method, params: { threadId: active.threadId, turnId: active.turnId, ...request.params } });
  else complete();
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line), { id, method, params = {} } = message;
  if (!method) { notify('serverRequest/resolved', { threadId: active.threadId, requestId: id }); next(); return; }
  if (method === 'initialize') { send({ id, result: { userAgent: 'offline-test', platformFamily: 'windows' } }); return; }
  if (method === 'initialized') { initialized = true; return; }
  if (!initialized) { send({ id, error: { code: -32000, message: 'Not initialized' } }); return; }
  if (method === 'test/echo') { setTimeout(() => send({ id, result: params }), params.delay ?? 0); return; }
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
  if (method === 'skills/list') { send({ id, result: { data: [{ cwd: root, skills: [{ name: 'codebase-wiki', path: path.join(root, '.agents/skills/codebase-wiki/SKILL.md'), enabled: true }] }] } }); return; }
  if (method === 'thread/start') { send({ id, result: { thread: { id: 'thread-' + ++sequence } } }); return; }
  if (method === 'thread/resume') { send({ id, result: { thread: { id: params.threadId } } }); return; }
  if (method === 'thread/turns/list') { send({ id, result: { data: mode === 'empty-thread' ? [] : [{ id: 'old-turn', items: [{ id: 'old-message', type: 'agentMessage', text: '先前已保存的結果' }] }], nextCursor: null } }); return; }
  if (method === 'turn/start') {
    active = { threadId: params.threadId, turnId: 'turn-' + ++sequence };
    send({ id, result: { turn: { id: active.turnId, status: 'inProgress', items: [] } } });
    notify('turn/started', { threadId: active.threadId, turn: { id: active.turnId } });
    const prompt = params.input[0].text;
    if (prompt.includes('drop-response')) { process.exit(4); }
    notify('item/agentMessage/delta', { ...active, itemId: 'agent-1', delta: '處理中' });
    if (prompt.includes('unknown-request')) {
      send({ id: 'unknown', method: 'item/tool/call', params: { ...active, name: 'unsupported' } }); return;
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
    if (!prompt.includes('hold')) setTimeout(() => complete(), 30);
    return;
  }
  if (method === 'turn/steer') { send({ id, result: { turnId: active.turnId } }); complete(); return; }
  if (method === 'turn/interrupt') { send({ id, result: {} }); complete('interrupted'); return; }
  send({ id, error: { code: -32601, message: 'unknown method' } });
});
rl.once('close', () => process.exit(0));
