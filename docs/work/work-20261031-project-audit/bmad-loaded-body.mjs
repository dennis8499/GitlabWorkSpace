// Fixed BMAD fixture + actual VSIX resources + mock host; no real installation.
await mkdir(output,{recursive:true});const temp=await mkdtemp(path.join(os.tmpdir(),'glw-bmad-loaded-'));let browser;
try{
  const files=await extractAssets(temp);browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const original=fixture.snapshot, results=[];
  for(const width of [800,1440])for(const theme of ['dark','light','highcontrast'])for(const spec of [
    {state:'ready',section:'start'},{state:'ready',section:'capabilities'},{state:'ready',section:'progress'},
    {state:'external-missing-uv',section:'start'},{state:'kit-error',section:'start'}]){
    let view;const name=`${spec.state}-${spec.section}-${width}-${theme}`;const entry={name,width,theme,...spec,status:'RUNNING'};results.push(entry);
    try{
      const root='C:/專案/服務 A', workspace=bmadWorkspaceSnapshot(root);
      let installed={status:'installed',version:'1.3.1',profile:'repository',integrity:'verified',interfaceCompatibility:'compatible',bmadMode:'bundled',
        capabilities:['query','visualize','bmad-workflow'],upstreamVersions:{'bmad-method':'6.12.4'}};
      if(spec.state==='external-missing-uv'){
        installed.bmadMode='external';const uv=workspace.bmadEnvironment.tools.find(tool=>tool.id==='uv');uv.state='missing';uv.reason='目前 PATH 找不到 uv。';delete uv.version;
      }
      if(spec.state==='kit-error')installed={status:'error',message:'無法驗證 WorkflowKit 安裝內容。'};
      workspace.workflowKit=installed;workspace.workflowKitInstallTarget.state=installed;workspace.workflowKitSource='github';
      workspace.workflowKitReleases=[{id:'fixture-1.3.1',version:'1.3.1',source:'github',assetName:'gitlab-workspace-kit-1.3.1.zip',format:'zip',entryRoot:'workflow-kit',available:true,skillCount:33}];
      workspace.skillsContext.installed=installed;workspace.skillsContext.availableFeatures=installed.capabilities??[];
      fixture.snapshot={...original,...workspace,connected:true,group:original.group,groups:original.groups,currentUser:original.currentUser,connectedScope:original.connectedScope,
        projects:original.projects,issues:original.issues,mergeRequests:original.mergeRequests};
      view=await mount(browser,files,width,theme==='highcontrast','reduce');
      if(theme==='light')await view.dashboard.locator('body').evaluate(body=>{
        body.className='vscode-light';const styles={'--vscode-foreground':'#1e1e1e','--vscode-editor-background':'#fff','--vscode-sideBar-background':'#f3f3f3',
          '--vscode-editorWidget-background':'#f3f3f3','--vscode-panel-border':'#b0b0b0','--vscode-widget-border':'#b0b0b0','--vscode-focusBorder':'#0078d4',
          '--vscode-descriptionForeground':'#555','--vscode-input-background':'#fff','--vscode-input-foreground':'#222','--vscode-input-border':'#888',
          '--vscode-textLink-foreground':'#005fb8','--vscode-errorForeground':'#a1260d','--vscode-editorWarning-foreground':'#895503'};
        for(const [key,value] of Object.entries(styles))body.ownerDocument.documentElement.style.setProperty(key,value);
      });
      await navigate(view,'bmad');await view.dashboard.locator('.bmad-panel:not(.bmad-loading)').waitFor({timeout:5000});
      await view.dashboard.locator(`#bmad-tab-${spec.section}`).click();
      if(spec.section==='start'){
        await view.dashboard.locator('#bmad-requirement').fill('請檢查付款流程，更新相關畫面並驗證結果。');
        const enabled=await view.dashboard.getByRole('button',{name:'複製 BMAD 提示詞'}).isEnabled();entry.copyPromptEnabled=enabled;
        if(spec.state==='ready'&&!enabled)throw new Error('ready fixture must allow copying a filled prompt');
        if(spec.state==='kit-error'&&enabled)throw new Error('failed kit verification must disable copying');
      }else if(spec.section==='capabilities')await view.dashboard.locator('.bmad-task-grid').waitFor();
      else await view.dashboard.getByText('購物車結帳',{exact:false}).first().waitFor();
      if(spec.state==='external-missing-uv'){
        await view.dashboard.getByText('偵測到外部 BMAD',{exact:false}).waitFor();await view.dashboard.getByText('找不到指令',{exact:false}).first().waitFor();
      }
      if(spec.state==='kit-error')await view.dashboard.getByText('無法驗證 WorkflowKit 安裝內容。',{exact:false}).waitFor();
      entry.layout=await view.dashboard.locator('body').evaluate(body=>({clientWidth:body.clientWidth,scrollWidth:body.scrollWidth,
        overflow:body.scrollWidth>body.clientWidth+1,loadingVisible:!!body.querySelector('.bmad-loading'),textExcerpt:body.innerText.slice(0,1200)}));
      await view.page.screenshot({path:path.join(output,`${name}-top.png`)});
      await view.dashboard.locator('.page').evaluate(element=>{element.scrollTop=element.scrollHeight;});await view.page.waitForTimeout(100);
      await view.page.screenshot({path:path.join(output,`${name}-bottom.png`)});
      entry.errors=view.errors;entry.blockedNetworkRequests=view.network;entry.status=entry.layout.overflow||entry.layout.loadingVisible||view.errors.length||view.network.length?'FAIL':'PASS';
    }catch(error){entry.status='ERROR';entry.error=error.message;}
    finally{if(view)await view.context.close();fixture.snapshot=original;}
    const report={scope:'Final packaged VSIX Webview with fixed BMAD fixture and isolated fake host in headless Chromium; themes approximated, not native VS Code',
      browser:browser.version(),artifactSha256:sha256(await readFile(artifactPath)),results};
    await writeFile(path.join(output,'bmad-loaded-results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({name,status:entry.status,error:entry.error}));
  }
}finally{await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
