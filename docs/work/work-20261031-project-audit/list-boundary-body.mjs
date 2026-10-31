await mkdir(output,{recursive:true});const temp=await mkdtemp(path.join(os.tmpdir(),'glw-list-boundary-'));let browser;
try {
  const files=await extractAssets(temp);browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const originalProjects=fixture.snapshot.projects,originalIssues=fixture.snapshot.issues,cases=[];
  for(const mode of ['clone','developer'])for(const count of [200,201,2000]){
    let view;const entry={mode,count,status:'RUNNING'};cases.push(entry);
    try{
      fixture.snapshot.projects=Array.from({length:count},(_,i)=>({...originalProjects[0],id:i+1,name:`scale-${String(i+1).padStart(4,'0')}`,path:`scale-${String(i+1).padStart(4,'0')}`,path_with_namespace:`fixture/team/scale-${String(i+1).padStart(4,'0')}`}));
      fixture.snapshot.issues=Array.from({length:count},(_,i)=>({...originalIssues[0],id:10000+i,project_id:1,iid:i+1,title:`Scale issue ${i+1}`}));
      view=await mount(browser,files,1440,false,'reduce');await navigate(view,mode);await view.page.waitForTimeout(500);
      const list=view.dashboard.locator(mode==='clone'?'.repo-list':'.work-list');const selector=mode==='clone'?'.repo-row':'.work-row';
      const label=mode==='clone'?`scale-${String(count).padStart(4,'0')}`:`Scale issue ${count}`;
      const state=()=>list.evaluate((element,selector)=>{
        const chain=[];for(let n=element;n && chain.length<7;n=n.parentElement){const s=getComputedStyle(n),r=n.getBoundingClientRect();chain.push({class:n.className,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight,scrollTop:n.scrollTop,overflowY:s.overflowY,rect:{top:r.top,bottom:r.bottom,height:r.height}});}
        return {rows:element.querySelectorAll(selector).length,first:element.querySelector(selector)?.innerText,last:[...element.querySelectorAll(selector)].at(-1)?.innerText,
          firstVirtualRow:element.querySelector('.virtual-list-row')?.getAttribute('data-virtual-index'),chain};
      },selector);
      entry.initial=await state();
      await list.evaluate(element=>{element.scrollTop=element.scrollHeight;});await view.page.waitForTimeout(300);entry.afterDirectScroll=await state();
      let last=list.locator(selector).filter({hasText:label});
      if(!(await last.count())){
        const first=list.locator(selector).first();
        if(mode==='clone')await first.locator('input').focus();else await first.focus();
        await view.page.keyboard.press('End');await view.page.waitForTimeout(300);last=list.locator(selector).filter({hasText:label});
      }
      entry.lastInDom=await last.count();
      if(entry.lastInDom){
        await last.scrollIntoViewIfNeeded();await view.page.waitForTimeout(200);entry.afterScrollIntoView=await state();
        entry.position=await last.evaluate(element=>{const r=element.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2));const hit=element.ownerDocument.elementFromPoint(x,y);return {rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},viewport:{width:innerWidth,height:innerHeight},hit:hit?.outerHTML.slice(0,250),hitWithin:element===hit||element.contains(hit)};});
        await view.page.screenshot({path:path.join(output,`${mode}-${count}-actual-last.png`)});
        if(mode==='clone'){await last.locator('input').click();entry.clicked=await last.locator('input').isChecked();}
        else{await last.click();entry.clicked=true;}
      }
      entry.errors=view.errors;entry.blocked=view.network;
      entry.virtualizationStatus=count<=200?'NOT_EXPECTED':entry.initial.rows<count?'PASS':'FAIL_ALL_ROWS_MOUNTED';
      entry.status=entry.lastInDom&&entry.position?.hitWithin&&entry.clicked&&!view.errors.length&&!view.network.length?'PASS':'FAIL';
    }catch(error){entry.status='ERROR';entry.error=error.message;}
    finally{if(view)await view.context.close();fixture.snapshot.projects=originalProjects;fixture.snapshot.issues=originalIssues;}
    await writeFile(path.join(output,'list-boundaries.json'),JSON.stringify({scope:'Actual VSIX in Chromium mock host, real viewport and hit testing; no VS Code or GitLab',browser:browser.version(),artifactSha256:sha256(await readFile(artifactPath)),cases},null,2)+'\n');console.log(JSON.stringify(entry));
  }
}finally{await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
