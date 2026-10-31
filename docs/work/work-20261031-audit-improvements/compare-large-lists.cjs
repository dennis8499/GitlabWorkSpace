'use strict';
const fs=require('node:fs');
const path=require('node:path');
const evidence=path.join(__dirname,'evidence');
const option=(name,fallback)=>{const index=process.argv.indexOf(name);return index<0?fallback:process.argv[index+1];};
const baseline=path.join(evidence,'baseline','large-list');
const revision=path.resolve(option('--revision',path.join(evidence,'revision','large-list')));
const output=path.resolve(option('--output',path.join(evidence,'large-list-comparison.json')));
const read=(directory,name)=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
const b=read(baseline,'results.json'), r=read(revision,'results.json');
const comparable=b.harnessSha256===r.harnessSha256&&b.browser===r.browser&&b.rounds===r.rounds&&b.samplesPerRound===r.samplesPerRound&&b.artifactSha256!==r.artifactSha256;
const before=read(baseline,'summary.json'), after=read(revision,'summary.json');
const results=before.map(old=>{
  const next=after.find(item=>item.mode===old.mode&&item.count===old.count&&item.kind===old.kind);
  if(!next)throw new Error(`Missing revision case ${JSON.stringify(old)}`);
  return {mode:old.mode,count:old.count,kind:old.kind,baseline:old,revision:next,
    p95ChangePercent:comparable&&old.p95Ms>0&&next.p95Ms!==null?Math.round((next.p95Ms/old.p95Ms-1)*100000)/1000:null,
    evaluationTargetP95Ms:100,revisionTarget:next.failures?'FAIL':next.p95Ms<=100?'PASS':'FAIL'};
});
const report={comparable,method:'Same packaged-UI harness, browser version, synthetic data and sample count. Scripted input to visible rows and two animation frames; not native input or network latency.',
  baselineSha256:b.artifactSha256,revisionSha256:r.artifactSha256,browser:b.browser,harnessSha256:b.harnessSha256,results};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if(!comparable)process.exitCode=1;
