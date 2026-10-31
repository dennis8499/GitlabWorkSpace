import { build } from 'vite';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Isolated real Renderer measurements; no GitLab, user browser or shared build assets.
const graph = fileURLToPath(new URL('file:///C:/Users/denni/OneDrive/Desktop/%E6%96%B0%E5%A2%9E%E8%B3%87%E6%96%99%E5%A4%BE/GitlabWorkSpace/src/webview/IssueGraph.tsx')).replaceAll('\\', '/');
const baseline = process.argv.includes('--baseline');
const workerSmoke = process.argv.includes('--worker-smoke');
const baselineSource = baseline ? execFileSync('git', ['show', 'HEAD:src/webview/IssueGraph.tsx'], { encoding: 'utf8' }) : undefined;
const result = await build({ configFile: false, publicDir: false, logLevel: 'silent',
  plugins: [{ name: 'graph-benchmark', resolveId: id => id === 'graph-benchmark' ? '\0graph-benchmark' : undefined,
    load: id => id.replaceAll('\\', '/') === graph && baseline ? baselineSource : id === '\0graph-benchmark' ? `import {h,render} from 'preact'; import {useState} from 'preact/hooks'; import {IssueGraphView} from ${JSON.stringify(graph)};
      const noop=()=>{}; const nodes=count=>Array.from({length:count},(_,i)=>({id:'n'+i,sourceIds:[],kind:'issue',projectId:1,namespacePath:'team/repo',iid:String(i+1),title:'Issue '+(i+1)+' renderer benchmark',state:'opened',labels:[{name:'feature',color:'#336699'}],assignees:[],boardIds:[1],assignedToMe:true,isRoot:true}));
      function App({count,animate}){const [selectedId,select]=useState();const [active,setActive]=useState(true);window.setGraphActive=setActive;const fixture=window.fixture??=new Map();if(!fixture.has(count)){const list=nodes(count);fixture.set(count,{nodes:list,edges:list.slice(1).map((node,i)=>({id:'e'+i,source:'n'+i,target:node.id,type:'relates_to'}))});}return h(IssueGraphView,{...fixture.get(count),boards:[{id:1,name:'Board'}],boardStatuses:{1:{status:'ready'}},projects:[],matchingRoots:new Set(fixture.get(count).nodes.map(n=>n.id)),selectedId,initialPositions:{},initialCamera:{x:0,y:0,scale:1},animationEnabled:animate,active,onAnimationEnabledChange:noop,onPositionsChange:positions=>window.latestPositions=positions,onCameraChange:noop,onSelect:select,onOpenIssue:noop});}
      window.mountGraph=(count,animate)=>render(h(App,{count,animate,key:count+':'+animate}),document.getElementById('root'));` : undefined }],
  build: { write: false, emptyOutDir: false, rollupOptions: { input: 'graph-benchmark', output: { format: 'es' } } } });
const script = result.output.find(item => item.type === 'chunk' && item.isEntry).code;
const css = await readFile(new URL('file:///C:/Users/denni/OneDrive/Desktop/%E6%96%B0%E5%A2%9E%E8%B3%87%E6%96%99%E5%A4%BE/GitlabWorkSpace/src/webview/dashboard.css'), 'utf8');
const html = `<!doctype html>${workerSmoke ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'unsafe-inline\'; worker-src blob:;">' : ''}<style>${css}html,body{margin:0;width:1400px;height:900px}#root{height:820px;padding:20px}.issue-graph-workspace{height:780px}</style><div id="root"></div>`;
const files = new Map(result.output.map(item => [item.fileName, item.type === 'chunk' ? item.code : item.source]));
if (process.env.GRAPH_DEBUG) process.stderr.write(JSON.stringify([...files.keys()]) + '\n');
if (process.env.GRAPH_DEBUG) process.stderr.write(script.slice(script.indexOf('new Worker') - 80, script.indexOf('new Worker') + 400) + '\n');
const server = createServer((request, response) => {
  const asset = files.get(request.url.slice(1));
  response.setHeader('Content-Type', asset ? 'application/javascript' : 'text/html'); response.end(asset ?? html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
// Source-based graph fixture; CDP TaskDuration is main-thread time, not OS CPU.
try {
  const destination = process.argv[2]; const measurements = [];
  for (const animate of [true, false]) {
    const page = await browser.newPage({ viewport:{width:1400,height:900} });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({type:'module',url:`http://127.0.0.1:${server.address().port}/${result.output.find(item => item.type === 'chunk' && item.isEntry).fileName}`});
    await page.waitForFunction(() => typeof window.mountGraph === 'function');
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    await page.evaluate(animate => window.mountGraph(2000, animate), animate);
    await page.locator('canvas').waitFor();
    await page.waitForTimeout(5000);
    const samples = [];
    for (let i=0; i<60; i++) {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const selected = Object.fromEntries(metrics.filter(({name}) => ['Timestamp','TaskDuration','ScriptDuration','JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','Frames'].includes(name)).map(({name,value}) => [name,value]));
      samples.push({ second:i, workers:page.workers().length, ...selected });
      await page.waitForTimeout(1000);
    }
    measurements.push({ animate, nodeCount:2000, samples, errors });
    await page.close();
    await writeFile(destination, JSON.stringify({scope:'2000 source graph nodes, isolated headless Chromium; TaskDuration is renderer main-thread time, not OS CPU or worker CPU; 60-second samples after five-second warmup',browser:browser.version(),measurements},null,2)+'\n');
    console.log(JSON.stringify({animate, sampleCount:samples.length, workers:samples.at(-1).workers, taskDurationSeconds:samples.at(-1).TaskDuration-samples[0].TaskDuration, usedHeapStart:samples[0].JSHeapUsedSize, usedHeapEnd:samples.at(-1).JSHeapUsedSize, errors}));
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
