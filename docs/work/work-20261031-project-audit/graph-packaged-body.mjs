await mkdir(output, {recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'glw-graph-packaged-')); let browser;
try {
  const files=await extractAssets(temp);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const view=await mount(browser,files,1440,false,'reduce');
  await view.page.evaluate(() => {
    const snapshot=window.__host.fixture.snapshot;
    const nodes=snapshot.issues.slice(0,3).map(issue=>({id:`project:${issue.project_id}:issue:${issue.iid}`,sourceIds:[],kind:'issue',
      namespacePath:`fixture/team/service-${String(issue.project_id).padStart(2,'0')}`,projectId:issue.project_id,iid:String(issue.iid),title:issue.title,
      state:'opened',labels:[],assignees:[],boardIds:[],assignedToMe:true,isRoot:true,relationsStatus:'ready'}));
    snapshot.issueGraph={connectedScope:snapshot.connectedScope,status:'ready',roots:nodes.map(n=>n.id),nodes,edges:[],boardIssueIds:{},boardStatus:{},errors:[],updatedAt:Date.now()};
    snapshot.issueGraphVersion=1; window.__host.publish();
  });
  await view.dashboard.locator('.developer-view-switch button').filter({hasText:'圖譜'}).click();
  const node=view.dashboard.locator('.graph-node').first(); await node.waitFor(); await view.page.waitForTimeout(1000);
  const inspect=()=>node.evaluate(element=>{
    const doc=element.ownerDocument, core=element.querySelector('.graph-node-core, .graph-node-sector');
    const style=e=>{const s=getComputedStyle(e);return {outline:s.outline,stroke:s.stroke,strokeWidth:s.strokeWidth,filter:s.filter,opacity:s.opacity};};
    return {focused:element===doc.activeElement,focusVisible:element.matches(':focus-visible'),selected:element.classList.contains('selected'),hasFocus:doc.hasFocus(),
      numericTabIndex:element.tabIndex,lowercaseTabindex:element.getAttribute('tabindex'),camelCaseTabIndex:element.getAttribute('tabIndex'),
      active:doc.activeElement?.outerHTML.slice(0,300),node:style(element),core:style(core),outerHTML:element.outerHTML.slice(0,500)};
  });
  const before=await inspect();
  await node.evaluate(element=>element.focus());
  const immediately=await inspect(); await view.page.waitForTimeout(250); const settled=await inspect();
  await view.dashboard.locator('body').screenshot({path:path.join(output,'node-focused.png')});
  await view.dashboard.locator('.graph-zoom-button').first().focus();
  const tabs=[];
  for(let i=0;i<30;i++){
    await view.page.keyboard.press('Tab');
    tabs.push(await view.dashboard.locator('body').evaluate(body=>({tag:body.ownerDocument.activeElement?.tagName,role:body.ownerDocument.activeElement?.getAttribute('role'),
      aria:body.ownerDocument.activeElement?.getAttribute('aria-label'),class:body.ownerDocument.activeElement?.getAttribute('class')})));
    if(tabs.at(-1).class?.includes('graph-node')) break;
  }
  const keyboard=await inspect();
  // Diagnostic intervention only: fix the DOM attribute in this isolated page to test causality.
  await node.evaluate(element=>{element.setAttribute('tabindex','0');element.focus();});
  const diagnosticLowercaseTabindex=await inspect();
  await view.dashboard.locator('body').screenshot({path:path.join(output,'node-lowercase-tabindex-diagnostic.png')});
  const report={scope:'Packaged VSIX dashboard; fake graph data and host, real headless Chromium; not native VS Code. Diagnostic intervention modifies only the isolated DOM.',browser:browser.version(),artifactSha256:sha256(await readFile(artifactPath)),before,immediately,settled,keyboard,tabs,diagnosticLowercaseTabindex,errors:view.errors,blocked:view.network};
  await writeFile(path.join(output,'graph-focus.json'),JSON.stringify(report,null,2)+'\n'); console.log(JSON.stringify(report,null,2));
  await view.context.close();
} finally { await browser?.close(); assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)); await rm(temp,{recursive:true,force:true}); }
