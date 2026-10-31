'use strict';
// Inspect only the locally installed built-in Git extension and package metadata.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const bin=spawnSync('where.exe',['code.cmd'],{encoding:'utf8'}).stdout.trim().split(/\r?\n/)[0];
const command=fs.readFileSync(bin,'utf8');
const match=command.match(/\.\.\\([^\\]+)\\resources\\app\\out\\cli\.js/i);
if(!match)throw new Error('Cannot locate the installed VS Code application from code.cmd.');
const app=path.resolve(path.dirname(bin),'..',match[1],'resources','app');
const product=JSON.parse(fs.readFileSync(path.join(app,'package.json'),'utf8'));
const script=fs.readFileSync(path.join(app,'extensions/git/dist/main.js'),'utf8');
const message='Deprecated. Use ApiRepository.getRefs() instead.';
const index=script.indexOf(message), before=script.slice(Math.max(0,index-100),index), after=script.slice(index,index+100);
const source=fs.readFileSync(path.resolve('src/git/gitRepositoryService.ts'),'utf8').split(/\r?\n/);
const result={installedVsCodeVersion:product.version,
  gitExtensionSha256:crypto.createHash('sha256').update(script).digest('hex'),
  warningOccurrences:script.split(message).length-1,
  warningLocatedInRefsGetter:/get refs\(\)\{return console\.warn\(["']$/.test(before),
  getterReturnsEmptyArray:/\),\[\]\}/.test(after),
  getBranchesDelegatesWithoutThisWarning:/getBranches\(e,t\)\{return this\.#e\.getBranches\(e,t\)\}/.test(script),
  sourceStateRefsLines:source.flatMap((line,index)=>/\bstate\.refs\b/.test(line)?[index+1]:[]),
  officialSources:{vscode190:'https://raw.githubusercontent.com/microsoft/vscode/1.90.0/extensions/git/src/api/api1.ts',
    vscode190Types:'https://raw.githubusercontent.com/microsoft/vscode/1.90.0/extensions/git/src/api/git.d.ts',
    vscode190Repository:'https://raw.githubusercontent.com/microsoft/vscode/1.90.0/extensions/git/src/repository.ts'}};
fs.writeFileSync(path.join(__dirname,'evidence','git-api-inventory.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
if(!result.warningLocatedInRefsGetter||!result.getterReturnsEmptyArray)process.exitCode=1;
