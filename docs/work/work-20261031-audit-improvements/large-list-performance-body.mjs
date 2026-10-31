// Appended to the packaged UI harness by run-packaged-probe.py.
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'glw-fix-large-list-'));
const results=[];
const rounds=Number(args.rounds ?? 10), samplesPerRound=Number(args.samples ?? 30);
const requested = new Set((args.cases ?? 'clone:2000,developer:2000,developer:10000').split(','));
if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(samplesPerRound) || samplesPerRound < 1) throw new Error('Invalid sample count');
let browser;
try {
  const files=await extractAssets(temp);
  browser=await chromium.launch({headless:true,executablePath:args.browser ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const originalProjects=fixture.snapshot.projects, originalIssues=fixture.snapshot.issues;
  for (const [mode,count] of [['clone',2000],['developer',2000],['developer',10000]]) {
    if (!requested.has(`${mode}:${count}`)) continue;
    for (let roundIndex=1;roundIndex<=rounds;roundIndex++) {
      const entry={mode,count,round:roundIndex,status:'RUNNING',samples:[]}; results.push(entry);
      let view;
      try {
        fixture.snapshot.projects=mode==='clone'?Array.from({length:count},(_,index)=>({...originalProjects[0],id:index+1,
          name:index===0?'unique-target':`scale-${String(index+1).padStart(5,'0')}`,
          path:index===0?'unique-target':`scale-${String(index+1).padStart(5,'0')}`,
          path_with_namespace:index===0?'fixture/team/unique-target':`fixture/team/scale-${String(index+1).padStart(5,'0')}`})):originalProjects;
        fixture.snapshot.issues=mode==='developer'?Array.from({length:count},(_,index)=>({...originalIssues[0],id:10000+index,project_id:1,iid:index+1,
          title:index===0?'unique-target':`Scale issue ${index+1}`})):originalIssues;
        view=await mount(browser,files,1440,false,'reduce'); await navigate(view,mode); await view.page.waitForTimeout(500);
        const list=view.dashboard.locator(mode==='clone'?'.repo-list':'.work-list');
        const selector=mode==='clone'?'.repo-row':'.work-row';
        entry.dom=await list.evaluate((element,row)=>({mounted:element.querySelectorAll(row).length,clientHeight:element.clientHeight,
          scrollHeight:element.scrollHeight,domNodes:element.ownerDocument.getElementsByTagName('*').length}),selector);
        for (let index=0;index<samplesPerRound;index++) for (const [query,kind] of [['unique-target','narrow'],['','restore']]) {
          const sample={index:index+1,kind}; entry.samples.push(sample);
          try {
            Object.assign(sample,await view.page.evaluate(async ({mode,query,kind})=>{
              const win=document.getElementById('dashboard').contentWindow,doc=win.document;
              const input=doc.querySelector(`input[aria-label="${mode==='clone'?'搜尋 Repo':'搜尋 Issue'}"]`);
              const row=mode==='clone'?'.repo-list .repo-row':'.work-list .work-row';
              const setter=Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value').set;
              const raf=()=>new Promise(resolve=>win.requestAnimationFrame(resolve));
              const started=win.performance.now();
              setter.call(input,query); input.dispatchEvent(new win.Event('input',{bubbles:true}));
              while (kind==='narrow'?doc.querySelectorAll(row).length!==1:doc.querySelectorAll(row).length<2) {
                if (win.performance.now()-started>10000) throw new Error('Timed out waiting for expected visible rows');
                await raf();
              }
              await raf(); await raf();
              return {status:'PASS',ms:win.performance.now()-started};
            },{mode,query,kind}));
          } catch(error) {sample.status='FAIL';sample.error=error.message;}
        }
        entry.errors=view.errors;entry.blocked=view.network;
        entry.status=entry.samples.every(sample=>sample.status==='PASS')&&!view.errors.length&&!view.network.length?'PASS':'FAIL';
      } catch(error) {entry.status='ERROR';entry.error=error.stack??String(error);}
      finally {await view?.context.close();fixture.snapshot.projects=originalProjects;fixture.snapshot.issues=originalIssues;}
      const report={schema:'GitLabWorkspaceLargeListImprovement/v1',artifactSha256:sha256(await readFile(artifactPath)),
        harnessSha256:sha256(await readFile(fileURLToPath(import.meta.url))),browser:browser.version(),rounds,samplesPerRound,
        scope:'Packaged Webview in headless Chromium with mock Host and synthetic data. Scripted DOM input, excludes native input, VS Code bridge and GitLab.',
        method:'A fresh context per round. Measure input event to expected visible rows followed by two animation frames. All samples, including errors, are retained.',cases:results};
      await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
      console.log(`${mode} ${count} round ${roundIndex}/${rounds}: ${entry.status}`);
    }
  }
  const summary=[];
  for (const [mode,count] of [['clone',2000],['developer',2000],['developer',10000]]) {
    const matching=results.filter(entry=>entry.mode===mode&&entry.count===count);
    if(!matching.length)continue;
    for(const kind of ['narrow','restore']){
      const all=matching.flatMap(entry=>entry.samples.filter(sample=>sample.kind===kind));
      const passed=all.filter(sample=>sample.status==='PASS').map(sample=>sample.ms);
      const required=rounds*samplesPerRound, failures=required-passed.length;
      summary.push({mode,count,kind,requiredSamples:required,attemptedSamples:all.length,failures,failurePercent:round(failures/required*100),
        p50Ms:passed.length?round(percentile(passed,.5)):null,p95Ms:passed.length?round(percentile(passed,.95)):null,
        mounted:matching.map(entry=>entry.dom?.mounted??null)});
    }
  }
  await writeFile(path.join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify(summary,null,2));
} finally {await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
if(results.some(entry=>entry.status!=='PASS'))process.exitCode=1;
