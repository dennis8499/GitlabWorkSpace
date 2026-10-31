// Packaged Webview with a simulated one-second Host timer and a real graph Worker.
const {appendFile}=await import('node:fs/promises');
const {createRequire}=await import('node:module');
const require=createRequire(path.join(process.cwd(),'package.json'));
const compiledRoot=path.resolve(args['compiled-root']??process.cwd());
const {IssueTimeTracker}=require(path.join(compiledRoot,'out/src/workspace/timeTracker.js'));
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'glw-fix-resource-'));
const animation=args.animation==='true', timer=args.timer==='true', seconds=Number(args.seconds??600);
let browser, tracker, ticker;
const adapterErrors=[];
try {
  const files=await extractAssets(temp);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const source=fixture.snapshot.issues[0], count=2000;
  fixture.snapshot.issues=Array.from({length:count},(_,index)=>({...source,id:10000+index,project_id:1,iid:index+1,title:`Resource Issue ${index+1}`}));
  const nodes=fixture.snapshot.issues.map(issue=>({id:`project:1:issue:${issue.iid}`,sourceIds:[],kind:'issue',namespacePath:'fixture/team/service-01',
    projectId:1,iid:String(issue.iid),title:issue.title,state:'opened',labels:[],assignees:[],boardIds:[],assignedToMe:true,isRoot:true,relationsStatus:'ready'}));
  fixture.snapshot.issueGraph={connectedScope:fixture.snapshot.connectedScope,status:'ready',roots:nodes.map(node=>node.id),nodes,edges:[],boardIssueIds:{},boardStatus:{},errors:[],updatedAt:Date.now()};
  fixture.snapshot.issueGraphVersion=1;
  fixture.snapshot.timerVersion=1;
  if(timer){
    const saved=new Map();
    const state={get:(key,fallback)=>saved.has(key)?saved.get(key):fallback,update:async(key,value)=>{
      saved.set(key,value);await writeFile(path.join(output,'simulated-timer-memento.json'),JSON.stringify(value)+'\n');}};
    tracker=new IssueTimeTracker(state);
    await tracker.setScope('https://fixture.invalid',7);
  }
  fixture.snapshot.timers=tracker?.list()??[];
  const view=await mount(browser,files,1440,false,'no-preference');
  const graphButton=view.dashboard.locator('.developer-view-switch button').filter({hasText:'圖譜'});
  const listButton=view.dashboard.locator('.developer-view-switch button').filter({hasText:'清單'});
  await graphButton.click(); await view.dashboard.locator('canvas').waitFor();
  for(let index=0;index<30;index++){
    await listButton.click(); await graphButton.click(); await view.dashboard.locator('canvas').waitFor();
  }
  const checkbox=view.dashboard.locator('.graph-animation-toggle input');
  if(await checkbox.isChecked()!==animation) await checkbox.click();
  if(await checkbox.isChecked()!==animation)throw new Error('Graph animation state did not match the requested fixture.');
  if(timer){
    await tracker.start({id:1,path_with_namespace:'fixture/team/service-01'},{iid:1,title:'Resource timer'});
    await view.page.evaluate(timers=>{window.__host.fixture.snapshot.timers=timers;window.__host.fixture.snapshot.timerVersion=2;window.__host.publish();},tracker.list());
    await view.page.evaluate(()=>{window.__resourceTimerTicks=0;});
    let version=2, ticking=false;
    ticker=setInterval(async()=>{
      if(ticking)return; ticking=true;
      try{
        if(await tracker.tick()){
          version++;
          await view.page.evaluate(({version,timers})=>{
            const host=window.__host,target=document.getElementById('dashboard').contentWindow;
            window.__resourceTimerTicks++;host.fixture.snapshot.timerVersion=version;host.fixture.snapshot.timers=timers;
            target.dispatchEvent(new MessageEvent('message',{data:{type:'timersChanged',instanceUserScope:host.fixture.snapshot.instanceUserScope,version,timers}}));
          },{version,timers:tracker.list()});
        }
      }catch(error){adapterErrors.push(error.message);}finally{ticking=false;}
    },1000);
    await view.dashboard.locator('.timer-status').waitFor();
  }
  await view.page.waitForTimeout(5000);
  const session=await view.context.newCDPSession(view.page);await session.send('Performance.enable');
  const browserSession=await browser.newBrowserCDPSession();
  const processInfo=async()=>{const result=await browserSession.send('SystemInfo.getProcessInfo');
    await writeFile(path.join(output,'process-types.json'),JSON.stringify({at:Date.now(),processes:result.processInfo},null,2)+'\n');};
  await processInfo();
  await writeFile(path.join(output,'ready.json'),JSON.stringify({at:Date.now(),animation,timer,seconds,preliminarySwitches:30,
    workers:view.page.workers().length,artifactSha256:sha256(await readFile(artifactPath)),browser:browser.version()})+'\n');
  const samplePath=path.join(output,'browser-samples.jsonl');
  for(let index=0;index<seconds;index++){
    const data=await session.send('Performance.getMetrics');
    const metrics=Object.fromEntries(data.metrics.filter(item=>['Timestamp','TaskDuration','ScriptDuration','JSHeapUsedSize','Nodes','Documents','Frames'].includes(item.name)).map(item=>[item.name,item.value]));
    const ticks=await view.page.evaluate(()=>window.__resourceTimerTicks??0);
    await appendFile(samplePath,JSON.stringify({index,at:Date.now(),workers:view.page.workers().length,timerTicks:ticks,...metrics})+'\n');
    if(index%10===0)await processInfo();
    if(index%60===0)console.log(`resource animation=${animation} timer=${timer}: ${index}/${seconds}`);
    await view.page.waitForTimeout(1000);
  }
  const result={scope:'Packaged Webview in headless Chromium with mock Host, real IssueTimeTracker in the test process and simulated file-backed Memento. Graph Worker is real; no VS Code Extension Host or GitLab.',
    animation,timer,seconds,preliminarySwitches:30,errors:view.errors,adapterErrors,blocked:view.network};
  await writeFile(path.join(output,'complete.json'),JSON.stringify(result,null,2)+'\n');
  if(view.errors.length||adapterErrors.length||view.network.length)process.exitCode=1;
  if(ticker)clearInterval(ticker);
  if(tracker)await tracker.detachScope();
  await view.context.close();
} finally {if(ticker)clearInterval(ticker);await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
