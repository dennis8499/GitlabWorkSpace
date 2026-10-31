'use strict';
// Read-only type checks on the current worktree, including unrelated concurrent edits.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const checks=['tsconfig.json','tsconfig.webview.json'].map(config=>{
  const result=spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',config,'--noEmit','--pretty','false'],
    {cwd:root,encoding:'utf8',windowsHide:true});
  return {config,exitCode:result.status,stdout:result.stdout,stderr:result.stderr};
});
const report={at:new Date().toISOString(),scope:'Current working tree, including unrelated concurrent changes; type checks only.',checks};
const target=path.join(__dirname,'evidence','current-worktree-typecheck.json');
fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(checks.map(({config,exitCode})=>({config,exitCode}))));
if(checks.some(item=>item.exitCode!==0))process.exitCode=1;
