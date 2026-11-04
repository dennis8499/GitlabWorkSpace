import path from 'node:path';
export async function run(): Promise<void> {
  const Mocha = require(require.resolve('mocha', { paths: [path.dirname(require.resolve('@vscode/test-cli'))] }));
  const mocha = new Mocha({ ui: 'tdd', timeout: 1_500_000 });
  mocha.addFile(path.resolve(__dirname, '../extension/codexFlow.test.js'));
  await new Promise<void>((resolve, reject) => mocha.run((failures: number) => failures ? reject(new Error(`${failures} Codex live checks failed`)) : resolve()));
}
