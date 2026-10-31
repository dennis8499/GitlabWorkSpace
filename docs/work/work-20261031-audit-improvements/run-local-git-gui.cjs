'use strict';
// The existing runner creates and removes its own local fixture and bare remote.
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const output=path.join(__dirname,'evidence','git-gui');
fs.mkdirSync(output,{recursive:true});
const log=fs.createWriteStream(path.join(output,'runner.log'));
const child=spawn(process.execPath,[path.join(root,'scripts/run-live-extension-tests.mjs'),'--local-git-gui',
  '--vsix',path.join(__dirname,'evidence/revision/gitlab-workspace-0.37.3.vsix'),'--evidence-dir',output],
  {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{log.write(data);process.stdout.write(data);});
child.on('error',error=>{console.error(error);process.exitCode=1;log.end();});
child.on('close',code=>{process.exitCode=code??1;log.end();});
