'use strict';
// Run the production Git service with the existing isolated unit fixture.
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const root=path.resolve(__dirname,'../../..');
const filename=path.join(root,'out/test/unit/gitRepositoryRefresh.test.js');
const source=fs.readFileSync(filename,'utf8'), boundary=source.indexOf('(0, node_test_1.default)(');
if(boundary<0)throw new Error('Git service fixture boundary changed.');
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
loaded._compile(source.slice(0,boundary)+'\nmodule.exports={fixture};\n',filename);
(async()=>{
  const fixture=await loaded.exports.fixture();
  try{
    let remote='origin/old', branchReads=0;
    fixture.repository.state.refs=[];
    fixture.repository.getBranches=async()=>{branchReads++;return [{name:remote,remote:'origin',type:1,commit:'b'.repeat(40)}];};
    const opened=await fixture.service.handleAction(fixture.id,{type:'open',repoId:fixture.id});
    const beforeReads=branchReads, before=opened.branches;
    fixture.repository.status=async()=>{remote='origin/new';fixture.emit();};
    const staged=await fixture.service.handleAction(fixture.id,{type:'stageFile',path:'README.md',staged:true});
    const report={scope:'Production Git service with the existing simulated Git fixture; the remote reference changes during staging while state.refs is empty.',
      actualRemote:remote,before,after:staged.branches,branchReadsBefore:beforeReads,branchReadsAfter:branchReads,
      referenceEpoch:fixture.service.referenceEpochs.get(fixture.id)};
    fs.writeFileSync(path.join(__dirname,'evidence','git-ref-cache-probe.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  }finally{fixture.service.dispose();}
})().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
