'use strict';
// Isolated unborn local branch with a real remote-tracking ref and commit.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const Module=require('node:module');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const repository=path.join(__dirname,'evidence','refs-repository');
const output=path.join(__dirname,'evidence','git-refs-probe.json');
const env={...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
  GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
function git(args,options={}){
  const result=spawnSync('git',args,{encoding:'utf8',windowsHide:true,env,...options});
  return {code:result.status,stdout:result.stdout?.trim()??'',stderr:result.stderr?.trim()??''};
}
(async()=>{
  await fsp.mkdir(repository,{recursive:true});
  const initialized=git(['init','--quiet','--initial-branch=unborn',repository]);
  if(initialized.code!==0)throw new Error(initialized.stderr);
  const tree=git(['-C',repository,'mktree'],{input:''});
  const commit=git(['-C',repository,'commit-tree',tree.stdout,'-m','synthetic remote history']);
  const update=git(['-C',repository,'update-ref','refs/remotes/origin/main',commit.stdout]);
  if([tree,commit,update].some(entry=>entry.code!==0))throw new Error(JSON.stringify({tree,commit,update}));
  const head=git(['-C',repository,'rev-parse','--verify','HEAD']);
  const actual=git(['-C',repository,'log','--all','-1','--format=%H']);
  const filename=path.join(root,'out/test/unit/gitRepositoryRefresh.test.js');
  const source=fs.readFileSync(filename,'utf8'), boundary=source.indexOf('(0, node_test_1.default)(');
  if(boundary<0)throw new Error('Git service fixture boundary changed.');
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source.slice(0,boundary)+'\nmodule.exports={fixture};\n',filename);
  process.chdir(repository);
  const fixture=await loaded.exports.fixture();
  try{
    fixture.repository.state.HEAD={name:'unborn',commit:undefined};
    fixture.repository.state.refs=[];
    const calls=[];
    fixture.service.runGit=async(_repository,args)=>{
      calls.push(args);const result=git(['-C',repository,...args]);
      if(result.code!==0)throw new Error(result.stderr);
      return {...result,stdout:result.stdout+'\n'};
    };
    const actualApi=await fixture.service.historyPage(fixture.repository,fixture.id);
    const actualCalls=calls.length;
    fixture.service.invalidateRepository(fixture.id);
    fixture.repository.state.refs=[{type:1,name:'origin/main',commit:commit.stdout}];
    const referencePresent=await fixture.service.historyPage(fixture.repository,fixture.id);
    const report={scope:'Real isolated local Git repository and production historyPage, with a simulated VS Code Git state.refs getter; no GitLab.',
      repository,head,actualLog:actual,syntheticCommit:commit.stdout,
      emptyRefs:{history:actualApi.history,gitCalls:actualCalls},
      controlRefs:{history:referencePresent.history,gitCalls:calls},
      officialVscode190:'https://raw.githubusercontent.com/microsoft/vscode/1.90.0/extensions/git/src/api/api1.ts',
      runtimeNote:'The locally installed Git extension getter warns and returns [] for state.refs; this probe does not launch VS Code.'};
    await fsp.writeFile(output,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
    if(head.code===0||actual.stdout!==commit.stdout||actualApi.history.length!==0||referencePresent.history.length!==1)process.exitCode=1;
  }finally{fixture.service.dispose();process.chdir(root);}
})().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
