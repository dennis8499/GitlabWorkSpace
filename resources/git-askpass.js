'use strict';
// The Git-owned helper only relays one prompt through authenticated local IPC.
// Credentials are returned to Git via stdout and are never written to a file.
const net = require('node:net');
const address = process.env.GITLAB_WORKSPACE_ASKPASS_PIPE;
const nonce = process.env.GITLAB_WORKSPACE_ASKPASS_NONCE;
const mode = process.argv[2], prompt = process.argv[3];
if (!address || !/^[a-f0-9]{48}$/.test(nonce || '') || !['http', 'ssh'].includes(mode) || typeof prompt !== 'string' || Buffer.byteLength(prompt) > 4096 || prompt.includes('\0')) process.exit(1);
let received = 0, settled = false, replyAccepted = false; const chunks = [];
const socket = net.createConnection(address);
const timer = setTimeout(() => finish(1), 120000);
function finish(code) { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); process.exitCode = code; }
socket.on('error', () => { if (!replyAccepted) finish(1); });
socket.on('connect', () => socket.write(JSON.stringify({ schema: 'GitLabWorkspaceAskpass/v1', nonce, mode, prompt }) + '\n'));
socket.on('data', chunk => {
  received += chunk.length;
  if (received > 32768) return finish(1);
  chunks.push(chunk);
  if (!chunk.includes(10)) return;
  try {
    const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (reply.schema !== 'GitLabWorkspaceAskpassReply/v1' || reply.nonce !== nonce || reply.cancelled || typeof reply.value !== 'string' || reply.value.length > 4096 || /[\r\n\0]/.test(reply.value)) return finish(1);
    replyAccepted = true; process.stdout.write(reply.value + '\n', () => finish(0));
  } catch { finish(1); }
});
socket.on('end', () => { if (!settled && !replyAccepted) finish(1); });
