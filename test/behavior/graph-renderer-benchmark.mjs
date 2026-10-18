import { build } from 'vite';
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Isolated real Renderer measurements; no GitLab, user browser or shared build assets.
const graph = fileURLToPath(new URL('../../src/webview/IssueGraph.tsx', import.meta.url)).replaceAll('\\', '/');
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
const css = await readFile(new URL('../../src/webview/dashboard.css', import.meta.url), 'utf8');
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
try {
  if (workerSmoke) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.workerMessages = []; window.workerUrls = []; window.workerErrors = []; window.workerReplies = 0; window.terminatedWorkers = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) { super(url, options); window.workerUrls.push(String(url)); this.addEventListener('message', () => window.workerReplies++); this.addEventListener('error', event => window.workerErrors.push(event.message)); }
        postMessage(message, ...args) { window.workerMessages.push(message.type === 'activity' ? { type: message.type, active: message.active } : { type: message.type }); return super.postMessage(message, ...args); }
        terminate() { window.terminatedWorkers++; return super.terminate(); }
      };
    });
    await page.addScriptTag({ type: 'module', url: `http://127.0.0.1:${server.address().port}/${result.output.find(item => item.type === 'chunk' && item.isEntry).fileName}` });
    await page.waitForFunction(() => typeof window.mountGraph === 'function');
    await page.evaluate(() => window.mountGraph(2000, true));
    await page.locator('canvas').waitFor();
    const urls = await page.evaluate(() => window.workerUrls);
    if (!urls.length || urls.some(url => !url.startsWith('blob:'))) throw new Error('VS Code graph layout must start inline Blob Workers: ' + JSON.stringify(urls));
    await page.waitForFunction(() => window.workerReplies > 0, undefined, { timeout: 5000 });
    if (page.workers().length !== 1) throw new Error('The mounted graph must have exactly one active layout Worker.');
    await page.evaluate(() => window.setGraphActive(false));
    await page.waitForFunction(() => window.workerMessages.at(-1)?.type === 'activity' && window.workerMessages.at(-1)?.active === false);
    await page.evaluate(() => window.setGraphActive(true));
    await page.waitForFunction(() => window.workerMessages.at(-1)?.type === 'activity' && window.workerMessages.at(-1)?.active === true);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.workerMessages.at(-1)?.type === 'activity' && window.workerMessages.at(-1)?.active === false);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => window.workerMessages.at(-1)?.type === 'activity' && window.workerMessages.at(-1)?.active === true);
    const terminatedBeforeUnmount = await page.evaluate(() => window.terminatedWorkers);
    await page.evaluate(() => window.mountGraph(200, false));
    await page.waitForFunction(previous => window.terminatedWorkers === previous + 1 && !document.querySelector('canvas'), terminatedBeforeUnmount);
    const diagnostics = await page.evaluate(() => ({ workerUrls: window.workerUrls, workerReplies: window.workerReplies, workerErrors: window.workerErrors, terminatedWorkers: window.terminatedWorkers }));
    if (errors.length || diagnostics.workerErrors.length) throw new Error(JSON.stringify({ errors, ...diagnostics }));
    const report = { schema: 'GitLabWorkspaceGraphWorkerSmoke/v1', checkedAt: new Date().toISOString(), browser: browser.version(), scriptSha256: createHash('sha256').update(script).digest('hex'), workerPolicy: 'worker-src blob:', checks: ['inline Blob constructor', 'real layout replies', 'inactive pause', 'resume', 'hidden pause', 'visibility resume', 'terminate on unmount'], ...diagnostics, errors };
    const destination = process.argv.slice(2).find(argument => !argument.startsWith('--'));
    if (destination) await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    await page.close();
  } else {
  const measurements = [];
  for (let round = 0; round < Number(process.env.GRAPH_ROUNDS ?? 1); round++) for (const count of [200, 2000]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    if (process.env.GRAPH_DEBUG) { page.on('console', message => process.stderr.write(message.text() + '\n')); page.on('pageerror', error => process.stderr.write(error.stack + '\n')); page.on('requestfailed', request => process.stderr.write(request.url() + ' ' + JSON.stringify(request.failure()) + '\n')); }
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.workerMessages = []; window.workerErrors = []; window.terminatedWorkers = 0;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { try { super(...args); this.addEventListener('error', event => window.workerErrors.push(event.message)); } catch (error) { window.workerErrors.push(String(error)); throw error; } }
        postMessage(message, ...args) { window.workerMessages.push(message.type === 'activity' ? { type: message.type, active: message.active } : { type: message.type }); return super.postMessage(message, ...args); }
        terminate() { window.terminatedWorkers++; return super.terminate(); }
      };
    });
    await page.addScriptTag({ type: 'module', url: `http://127.0.0.1:${server.address().port}/${result.output.find(item => item.type === 'chunk' && item.isEntry).fileName}` });
    await page.waitForFunction(() => typeof window.mountGraph === 'function');
    measurements.push(await page.evaluate(async count => {
      const raf = () => new Promise(resolve => requestAnimationFrame(resolve));
      const tasks = [], frameGaps = [], phases = []; let previous = performance.now(), recording = true;
      const frames = now => { if (recording) { frameGaps.push(now - previous); previous = now; requestAnimationFrame(frames); } };
      requestAnimationFrame(frames);
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))); observer.observe({ type: 'longtask', buffered: false });
      const started = performance.now(); window.mountGraph(count, true); await raf(); await raf();
      const mountPaintMs = performance.now() - started;
      phases.push({ name: 'mount', start: started, end: performance.now() });
      await new Promise(resolve => setTimeout(resolve, 500));
      const selectionPaintMs = [], zoomPaintMs = [];
      const selectionStart = performance.now();
      for (let i = 0; i < 30; i++) {
        const nodes = document.querySelectorAll('.graph-node'), canvas = document.querySelector('canvas');
        const start = performance.now();
        if (canvas) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        else nodes[i % nodes.length].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await raf(); await raf(); selectionPaintMs.push(performance.now() - start);
      }
      phases.push({ name: 'selection', start: selectionStart, end: performance.now() });
      const zoomStart = performance.now();
      for (let i = 0; i < 15; i++) {
        const svg = document.querySelector('.issue-graph-svg'), rect = svg.getBoundingClientRect(); const start = performance.now();
        svg.dispatchEvent(new WheelEvent('wheel', { deltaY: i % 2 ? 10 : -10, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: true }));
        await raf(); await raf(); zoomPaintMs.push(performance.now() - start);
      }
      phases.push({ name: 'zoom', start: zoomStart, end: performance.now() });
      await new Promise(resolve => setTimeout(resolve, 100)); recording = false; observer.disconnect();
      const percentile = (values, p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] ?? 0;
      return { count, mountPaintMs, selectionPaintP95Ms: percentile(selectionPaintMs,.95), zoomPaintP95Ms: percentile(zoomPaintMs,.95),
        frameGapP95Ms: percentile(frameGaps,.95), longTaskCount: tasks.length, maxLongTaskMs: Math.max(0,...tasks.map(task=>task.duration)),
        longTasksByPhase: Object.fromEntries(phases.map(phase=>[phase.name,tasks.filter(task=>task.start>=phase.start&&task.start<phase.end).map(task=>task.duration)])),
        nodesInDom: document.querySelectorAll('.graph-node').length,
        selectionPaintMs, zoomPaintMs };
    }, count));
    const measured = measurements.at(-1); measured.round = round + 1; measured.workers = page.workers().length;
    if (!baseline && count === 2000) {
      if (measured.workers !== 1) throw new Error('Large graphs must run force layout in one real Worker. ' + JSON.stringify(await page.evaluate(() => ({ errors: window.workerErrors, messages: window.workerMessages }))));
      await page.evaluate(() => window.setGraphActive(false));
      await page.waitForFunction(() => window.workerMessages.some(message => message.type === 'activity' && message.active === false));
      const search = page.getByRole('searchbox', { name: '尋找圖譜節點' }); await search.fill('Issue 1999 renderer benchmark');
      await page.getByRole('button', { name: '#1999 Issue 1999 renderer benchmark', exact: true }).click();
      await page.locator('.graph-selected-detail h2').filter({ hasText: 'Issue 1999 renderer benchmark' }).waitFor();
      await page.locator('canvas').focus(); await page.keyboard.press('End');
      await page.locator('.graph-selected-detail h2').filter({ hasText: 'Issue 2000 renderer benchmark' }).waitFor();
      await page.keyboard.press('Home');
      await page.locator('.graph-selected-detail h2').filter({ hasText: /^Issue 1 renderer benchmark$/ }).waitFor();
      await page.evaluate(() => window.setGraphActive(true));
      await page.waitForFunction(() => window.workerMessages.at(-1)?.type === 'activity' && window.workerMessages.at(-1)?.active === true);
      const terminated = await page.evaluate(() => window.terminatedWorkers);
      if (process.env.GRAPH_SCREENSHOT && round === 0) await page.screenshot({ path: process.env.GRAPH_SCREENSHOT });
      await page.evaluate(() => window.mountGraph(200, true));
      await page.waitForFunction(previous => window.terminatedWorkers > previous && !document.querySelector('canvas'), terminated);
      measured.interactionChecks = ['worker', 'inactive pause', 'resume', 'search', 'keyboard Home/End', 'terminate on unmount'];
    }
    process.stdout.write(JSON.stringify({ round: round + 1, count, source: baseline ? 'HEAD' : 'working-tree', p95: measured.selectionPaintP95Ms }) + '\n');
    await page.close();
  }
  const report = { schema: 'GitLabWorkspaceGraphRenderer/v1', source: baseline ? 'HEAD' : 'working-tree', scriptSha256: createHash('sha256').update(script).digest('hex'), browser: browser.version(), measuredAt: new Date().toISOString(), measurements };
  const destination = process.argv.slice(2).find(argument => !argument.startsWith('--'));
  if (destination) await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
