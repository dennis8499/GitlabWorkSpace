await mkdir(output, {recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'glw-geometry-diagnostic-'));
let browser, view;
try {
  const files=await extractAssets(temp);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',ignoreDefaultArgs:['--hide-scrollbars']});
  const original=fixture.snapshot.issues[0];
  fixture.snapshot.issues=Array.from({length:300},(_,index)=>({...original,id:10000+index,project_id:1,iid:index+1,
    title:`Issue with a long variable length title ${'word '.repeat(index%5+1)}${index+1}`,
    labels:Array.from({length:index%5},(_,item)=>`long-label-${index}-${item}`)}));
  view=await mount(browser,files,800,false,'reduce');await navigate(view,'developer');
  const list=view.dashboard.locator('.work-list');
  await list.evaluate(element=>{element.scrollTop=element.scrollHeight*.5;}); await view.page.waitForTimeout(800);
  const capture=()=>list.evaluate(element=>({clientWidth:element.clientWidth,clientHeight:element.clientHeight,scrollTop:element.scrollTop,
    scrollHeight:element.scrollHeight, zoom:getComputedStyle(element).zoom,
    rows:[...element.querySelectorAll('.virtual-list-row')].slice(0,8).map(row=>({index:row.dataset.virtualIndex,
      topStyle:row.style.top,offsetHeight:row.offsetHeight,offsetTop:row.offsetTop,rect:row.getBoundingClientRect().toJSON(),
      text:row.textContent.slice(0,80)})), observations:window.__geometryObservations??[]}));
  await list.locator('.virtual-list-row').first().evaluate(row=>{
    window.__geometryObservations=[];
    window.__geometryObserver=new ResizeObserver(entries=>entries.forEach(entry=>window.__geometryObservations.push({
      time:performance.now(),index:entry.target.dataset.virtualIndex,borderBox:entry.borderBoxSize?.[0]?.blockSize,
      contentHeight:entry.contentRect.height,offsetHeight:entry.target.offsetHeight,rectHeight:entry.target.getBoundingClientRect().height})));
    window.__geometryObserver.observe(row);
  });
  const phases=[];
  phases.push({name:'before',data:await capture()});
  await view.page.setViewportSize({width:730,height:900});
  await view.page.evaluate(()=>{document.getElementById('dashboard').style.width='430px';});
  await view.dashboard.locator('body').evaluate(element=>{element.style.zoom='2';});
  for(const delay of [100,900,3000]) {await view.page.waitForTimeout(delay);phases.push({name:`after-${delay}`,data:await capture()});}
  await writeFile(path.join(output,'geometry.json'),JSON.stringify({artifactSha256:sha256(await readFile(artifactPath)),phases},null,2)+'\n');
  console.log(JSON.stringify(phases.map(phase=>({name:phase.name,rows:phase.data.rows.slice(0,3),observations:phase.data.observations})),null,2));
} finally {await view?.context.close();await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
