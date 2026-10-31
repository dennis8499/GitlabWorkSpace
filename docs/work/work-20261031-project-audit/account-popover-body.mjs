await mkdir(output,{recursive:true});const temp=await mkdtemp(path.join(os.tmpdir(),'glw-popover-'));let browser;
try{
  const files=await extractAssets(temp);browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});const cases=[];
  for(const width of [430,640,800,1440]){
    const view=await mount(browser,files,width,false,'reduce');
    try{
      await view.dashboard.locator('.account-menu > summary').click();await view.dashboard.locator('.account-menu[open] .account-popover').waitFor();
      const data=await view.dashboard.locator('.account-popover').evaluate(element=>{
        const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
        return {viewport:innerWidth,popover:rect(element),buttons:[...element.querySelectorAll('button')].map(button=>({label:button.innerText,rect:rect(button)}))};
      });
      await view.page.screenshot({path:path.join(output,`popover-${width}.png`)});
      cases.push({width,...data,errors:view.errors,blocked:view.network});
    }finally{await view.context.close();}
  }
  const report={scope:'Actual packaged UI, fake Host, headless Chromium; dashboard width excludes the 300px fake sidebar',browser:browser.version(),artifactSha256:sha256(await readFile(artifactPath)),cases};
  await writeFile(path.join(output,'account-popover.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
