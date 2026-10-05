const fs = require('node:fs');

const stateFile = process.env.GITLABWORKSPACE_REBASE_UI_FILE;
const mode = process.argv[2];
if (!stateFile || !fs.existsSync(stateFile)) process.exit(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const target = process.argv[3];
if (!target) process.exit(2);

if (mode === 'sequence') {
  try { fs.unlinkSync(stateFile + '.editor-index'); } catch { /* A fresh rebase starts with an empty editor queue. */ }
  const content = state.todo.map((item) => item.action + ' ' + item.hash).join('\n') + '\n';
  fs.writeFileSync(target, content, 'utf8');
} else if (mode === 'message') {
  const queue = Array.isArray(state.editorMessages) ? state.editorMessages : [];
  const indexFile = stateFile + '.editor-index';
  const index = Number(fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : 0);
  const message = Number.isSafeInteger(index) && index >= 0 ? queue[index] : undefined;
  if (message === undefined) process.exit(2);
  fs.writeFileSync(target, message + '\n', 'utf8');
  fs.writeFileSync(indexFile, String(index + 1), 'utf8');
} else {
  process.exit(2);
}
