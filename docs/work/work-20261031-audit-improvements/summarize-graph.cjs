'use strict';
const fs=require('node:fs');
const path=require('node:path');
const index=process.argv.indexOf('--dir');
const dir=index<0?path.join(__dirname,'evidence','graph'):path.resolve(process.argv[index+1]);
const data=JSON.parse(fs.readFileSync(path.join(dir,'graph-10rounds.json'),'utf8'));
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const rounded=value=>Math.round(value*1000)/1000;
const summary=[200,500,501,2000].map(count=>{
  const runs=data.measurements.filter(item=>item.count===count), selections=runs.flatMap(item=>item.selectionPaintMs),
    zooms=runs.flatMap(item=>item.zoomPaintMs),frames=runs.flatMap(item=>item.frameGapsMs);
  return {count,rounds:runs.length,selectionSamples:selections.length,selectionP50Ms:rounded(percentile(selections,.5)),
    selectionP95Ms:rounded(percentile(selections,.95)),zoomSamples:zooms.length,zoomP50Ms:rounded(percentile(zooms,.5)),
    zoomP95Ms:rounded(percentile(zooms,.95)),frameGapP95Ms:rounded(percentile(frames,.95)),
    longTasks:runs.reduce((total,item)=>total+item.longTaskCount,0),maxLongTaskMs:Math.max(...runs.map(item=>item.maxLongTaskMs)),
    workers:[...new Set(runs.map(item=>item.workers))]};
});
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify({scope:'Working-tree source graph, synthetic data and isolated Chromium; not native VS Code or GitLab. Selection and zoom wait for two animation frames.',
  browser:data.browser,scriptSha256:data.scriptSha256,summary},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
