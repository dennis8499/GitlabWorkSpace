'use strict';
// Uses only a new local bare repository and new fixture files under this evidence directory.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '../../..');
const evidence = path.join(__dirname, 'evidence');
const work = path.join(evidence, 'p');
const quick = process.argv.includes('--quick');
const reportPath = path.join(evidence, quick ? 'path-probe-encoding.json' : 'path-probe.json');
const sourcePath = path.join(root, 'resources/windows-git-supervisor.ps1');
const diagnostic = path.join(evidence, 'diagnostic-windows-git-supervisor.ps1');
const git = spawnSync('where.exe', ['git.exe'], {encoding:'utf8'}).stdout.trim().split(/\r?\n/)[0];
const cases = [];
async function run(target, round, instrumented, repository) {
  const nonce = randomUUID();
  const suffix = `execution-${nonce}.json.tmp-${nonce}`;
  const padding = target - work.length - 1 - 1 - suffix.length;
  const name = `${target}-${String(round).padStart(2,'0')}-${instrumented?'d':'p'}`;
  if (padding < name.length) throw new Error('Evidence root is too long for the requested path.');
  const lease = path.join(work, name.padEnd(padding, 'x'));
  await fs.mkdir(lease, {recursive:true});
  const receiptPath = path.join(lease, `execution-${nonce}.json`);
  const temporary = `${receiptPath}.tmp-${nonce}`;
  if (temporary.length !== target) throw new Error(`Incorrect temporary path length: ${temporary.length}`);
  const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    instrumented ? diagnostic : sourcePath], {windowsHide:true,stdio:['pipe','pipe','pipe']});
  const stdoutChunks=[], stderrChunks=[];
  child.stdout.on('data', data => stdoutChunks.push(data));
  child.stderr.on('data', data => stderrChunks.push(data));
  const started = Date.now();
  const result = await new Promise((resolve,reject) => {
    const timeout = setTimeout(() => {child.kill(); reject(new Error('Supervisor probe timed out'));},30000);
    child.on('error',reject); child.on('close',code => {clearTimeout(timeout);resolve(code);});
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({schema:'GitLabWorkspaceWindowsGit/v1',executable:git,args:['ls-remote',repository],
      cwd:repository,timeoutMs:10000,receiptPath,nonce,inputBase64:''}));
  });
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(receiptPath,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stdout=Buffer.concat(stdoutChunks).toString('utf8'), stderrBytes=Buffer.concat(stderrChunks);
  const stderr=new TextDecoder('big5').decode(stderrBytes);
  return {targetTemporaryLength:target,actualTemporaryLength:temporary.length,round,instrumented,code:result,
    stdout,stderr,stderrBase64:stderrBytes.toString('base64'),receipt:receipt ?? null,elapsedMs:Date.now()-started,relativeReceipt:path.relative(evidence,receiptPath)};
}
(async () => {
  await fs.mkdir(work,{recursive:true});
  const repository = path.join(work,'fixture-remote.git');
  const init = spawnSync(git,['init','--bare',repository],{encoding:'utf8',windowsHide:true});
  if (init.status !== 0) throw new Error(`Cannot create isolated bare repository: ${init.stderr}`);
  let source = await fs.readFile(sourcePath,'utf8');
  const inner = /\} catch \{\s*if \(!started\) \{/;
  if (!inner.test(source)) throw new Error('Supervisor catch changed; inspect before adding diagnostics.');
  source = source.replace(inner, '} catch (Exception auditError) {\n            try { Console.Error.WriteLine("AUDIT_CSHARP " + auditError.GetType().FullName + ": " + auditError.Message); } catch {}\n            if (!started) {');
  source = source.replace("[Console]::Error.WriteLine('Git supervisor request could not be processed.')",
    "[Console]::Error.WriteLine('AUDIT_POWERSHELL ' + $_.Exception.ToString())");
  await fs.writeFile(diagnostic,source,'utf8');
  const report = {scope:'Same isolated local bare repository and ls-remote command; no remote Git writes. The diagnostic supervisor is a copy with exception logging only.',
    platform:process.platform,node:process.version,git,supervisor:sourcePath,cases};
  for (const instrumented of [true,false]) for (const target of quick?[260]:[212,259,260,268]) for (let round=1;round<=(instrumented&&!quick?10:1);round++) {
    const entry=await run(target,round,instrumented,repository); cases.push(entry);
    await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({length:target,round,instrumented,code:entry.code,receipt:!!entry.receipt,stderr:entry.stderr.trim().slice(0,180)}));
  }
})().catch(error => { console.error(error.stack ?? error); process.exitCode=1; });
