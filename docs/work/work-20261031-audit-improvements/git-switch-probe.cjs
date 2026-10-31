'use strict';
// Reuses the repository's compiled service and WorkspacePanel test fixtures.
// Git execution is mocked; only two new local fixture directories are created.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname,'../../..');
const output = path.join(__dirname,'evidence','git-switch-probe.json');
const work = path.join(__dirname,'evidence','switch-repos');

function loadFixture(relative, extra) {
  const filename = path.join(root,'out/test/unit',relative);
  let compiled = fs.readFileSync(filename,'utf8');
  if (relative === 'gitRepositoryRefresh.test.js') {
    // The test fixture evaluates the service in a VM. Production shares the
    // Host's Error constructor, so keep that identity for readableError().
    const original = 'exports: moduleExports, Buffer, process, AbortController, AbortSignal,';
    if (!compiled.includes(original)) throw new Error('Git service fixture VM changed.');
    compiled = compiled.replace(original, 'exports: moduleExports, Buffer, process, AbortController, AbortSignal, Error,');
  }
  const marker = '(0, node_test_1.default)(';
  const offset = compiled.indexOf(marker);
  if (offset < 0) throw new Error(`Fixture boundary changed: ${filename}`);
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled.slice(0,offset) + `\nmodule.exports = ${extra};\n`, filename);
  return loaded.exports;
}
const tick = () => new Promise(resolve => setTimeout(resolve,2));
async function waitUntil(predicate,label) {
  const deadline = performance.now()+5000;
  while (!predicate()) { if (performance.now()>deadline) throw new Error(`Timed out waiting for ${label}`); await tick(); }
}
(async () => {
  await fsp.mkdir(work,{recursive:true});
  const a = path.join(work,'a'), b = path.join(work,'b');
  for (const folder of [a,b]) {
    await fsp.mkdir(folder,{recursive:true});
    const result = spawnSync('git',['init','--quiet',folder],{encoding:'utf8',windowsHide:true});
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const repositoryFixture = loadFixture('gitRepositoryRefresh.test.js','{fixture, withLock:repositoryOperationLock_1.withGitDirectoryLock}');
  const hostFixture = loadFixture('workspaceOperationLifecycle.test.js','{fixture, WorkspacePanel}');
  process.chdir(a);
  const git = await repositoryFixture.fixture(), panel = hostFixture.fixture();
  const other = {...git.repository, rootUri:{fsPath:b}};
  git.api.repositories.push(other); git.service.publishRepositories();
  git.service.requireRepository = async id => git.service.findRepository(id);
  const secondId = git.service.repositoryId(b);
  Object.assign(panel.host,{activeMode:'git',gitRepositories:git.service,
    context:{globalState:{update:async()=>{}}}, dispatchMessage:hostFixture.WorkspacePanel.prototype.dispatchMessage});
  const trace=[];
  git.service.actionTraceHandler = event => trace.push({timeMs:performance.now(),operationId:panel.host.operationContext.getStore(),...event});
  const cases=[];
  const startedAt = new Date().toISOString();
  try {
    for (let index=0;index<100;index++) {
      const oldId=index%2 ? secondId : git.id, nextId=index%2 ? git.id : secondId;
      const oldRepo=index%2 ? other : git.repository, nextRepo=index%2 ? git.repository : other;
      const oldOp=`switch-old-${index}`, newOp=`switch-new-${index}`;
      const oldRequest=`old-request-${index}`, newRequest=`new-request-${index}`;
      const scenario=index%4===0?'queued-open':index%4===1?'queued-history':'inflight-refresh';
      const injectFailure=index%10===0;
      const entry={index,scenario,injectFailure,oldId,nextId,oldOp,newOp,oldRequest,newRequest,events:[]}; cases.push(entry);
      const stamp=(event,extra={})=>entry.events.push({event,timeMs:performance.now(),...extra});
      panel.host.selectedGitRepositoryId=oldId; git.service.setActivePanelRepository(oldId,false);
      const generation=git.service.activePanelGeneration; stamp('old-selected',{generation});
      let release, held, entered;
      if (scenario.startsWith('queued')) {
        const ready = new Promise(resolve => {entered=resolve;});
        held=repositoryFixture.withLock(oldRepo.rootUri.fsPath,()=>new Promise(resolve=>{release=resolve;entered();}));
        await ready;
      } else {
        const original=oldRepo.status;
        entry.restoreOld=()=>{oldRepo.status=original;};
        const ready=new Promise(resolve=>{entered=resolve;});
        oldRepo.status=async()=>{entered(); await new Promise(resolve=>{release=resolve;}); await original();};
        entry.ready=ready;
      }
      const oldAction=scenario==='queued-history'?{type:'history',skip:200+index}:
        scenario==='queued-open'?{type:'open',repoId:oldId,refresh:false}:{type:'refresh'};
      const pending=panel.host.handleMessage({type:'gitAction',operationId:oldOp,requestId:oldRequest,repoId:oldId,action:oldAction});
      stamp('old-request-started');
      if (scenario==='queued-open') await waitUntil(()=>git.service.snapshotTasks.size>0,'queued snapshot');
      else if (scenario==='queued-history') await waitUntil(()=>git.service.readTasks.size>0,'queued history');
      else await entry.ready;
      delete entry.ready; stamp('old-delayed');
      const oldStatus=nextRepo.status;
      if (injectFailure) nextRepo.status=async()=>{throw new Error('controlled real read failure');};
      await panel.host.handleMessage({type:'gitAction',operationId:newOp,requestId:newRequest,repoId:nextId,
        action:{type:'open',repoId:nextId,refresh:injectFailure}});
      nextRepo.status=oldStatus;
      stamp('new-request-finished',{generation:git.service.activePanelGeneration});
      release(); if (held) await held;
      await pending; if (entry.restoreOld) entry.restoreOld(); delete entry.restoreOld;
      stamp('old-request-finished');
      const oldState=panel.operations.get(oldOp), newState=panel.operations.get(newOp);
      const notifications=panel.host.notifications.snapshot().items;
      entry.old={status:oldState?.status,error:oldState?.error,effect:oldState?.effect,
        notification:notifications.find(n=>n.operationId===oldOp) ?? null,
        result:panel.messages.findLast(m=>m.type==='gitActionResult'&&m.requestId===oldRequest) ?? null,
        snapshotSent:panel.messages.some(m=>m.type==='gitSnapshot'&&m.requestId===oldRequest)};
      entry.current={status:newState?.status,error:newState?.error,effect:newState?.effect,
        notification:notifications.find(n=>n.operationId===newOp) ?? null,
        selected:panel.host.selectedGitRepositoryId===nextId};
      if (index%10===9) console.log(`Git switch ${index+1}/100`);
    }
    const report={scope:'Real compiled GitRepositoryService, WorkspacePanel, OperationTracker and NotificationCenter with two isolated local Git fixtures; Git API and command results are simulated.',
      startedAt, finishedAt:new Date().toISOString(),cases,trace};
    await fsp.writeFile(output,JSON.stringify(report,null,2)+'\n');
    const summary={cases:cases.length,scenarios:{},staleNotifications:0,currentFailures:0,selectedErrors:0};
    for (const item of cases) {
      const key=`${item.scenario}:${item.old.status}`; summary.scenarios[key]=(summary.scenarios[key]??0)+1;
      if (item.old.notification?.level==='error') summary.staleNotifications++;
      if (item.current.status==='failed') summary.currentFailures++;
      if (!item.current.selected) summary.selectedErrors++;
    }
    console.log(JSON.stringify(summary,null,2));
  } finally {git.service.dispose(); process.chdir(root);}
})().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
