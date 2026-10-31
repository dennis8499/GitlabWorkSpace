await mkdir(output,{recursive:true}); const temp=await mkdtemp(path.join(os.tmpdir(),'glw-ui-remoterepo-')); let browser;
try {
  const files=await extractAssets(temp);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  fixture.snapshot.projectLocalRepositories={}; fixture.snapshot.localWorkspaceRepositories=[]; fixture.snapshot.groupRepositories=[];
  fixture.snapshot.projects=fixture.snapshot.projects.slice(0,3).map((project,index)=>({...project,name:`customer-service-${index+1}`,
    path:`customer-service-${index+1}`,path_with_namespace:`organisation/very-long-group-name/platform/customer-service-${index+1}`}));
  const cases=[];
  for(const width of [430,800,1440]){
    const view=await mount(browser,files,width,false,'reduce');
    try{
      await navigate(view,'clone');
      const rows=await view.dashboard.locator('.repo-row').evaluateAll(elements=>elements.map(row=>{
        const title=row.querySelector('.repo-details strong'); const input=row.querySelector('input');
        return {text:title?.textContent,clientWidth:title?.clientWidth,scrollWidth:title?.scrollWidth,truncated:title?.scrollWidth>title?.clientWidth,
          titleAttribute:title?.getAttribute('title'),checkboxAriaLabel:input?.getAttribute('aria-label'),rowText:row.innerText};
      }));
      await view.dashboard.locator('body').screenshot({path:path.join(output,`remote-repos-${width}.png`)});
      cases.push({width,rows,errors:view.errors,blocked:view.network});
    }finally{await view.context.close();}
  }
  const report={scope:'Actual packaged VSIX dashboard, fixed long remote-only Repo names, mock host, headless Chromium',browser:browser.version(),artifactSha256:sha256(await readFile(artifactPath)),cases};
  await writeFile(path.join(output,'remote-repos.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
