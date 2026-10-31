// Appended to the packaged UI harness by run-packaged-probe.py.
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-fix-functional-'));
const results = [];
let browser;
const run = async (name, action) => {
  const entry = { name, status: 'RUNNING' }; results.push(entry);
  try { entry.detail = await action(); entry.status = 'PASS'; }
  catch (error) { entry.status = 'FAIL'; entry.error = error.stack ?? String(error); }
  await writeFile(path.join(output, 'functional.json'), JSON.stringify({
    artifactSha256: sha256(await readFile(artifactPath)), browser: browser.version(),
    scope: 'Packaged VSIX Webview, synthetic data and mock Host in Chromium; not native VS Code or GitLab.', cases: results
  }, null, 2) + '\n');
  console.log(`${entry.status} ${name}${entry.error ? ': ' + entry.error.split('\n')[0] : ''}`);
};
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const originalProjects = fixture.snapshot.projects, originalIssues = fixture.snapshot.issues;
  await run('Repo full accessible names and label/keyboard toggle', async () => {
    const view = await mount(browser, files, 430, false, 'reduce');
    try {
      await navigate(view, 'clone');
      const row = view.dashboard.locator('.repo-row').first();
      const name = originalProjects[0].path_with_namespace;
      const checkbox = row.getByRole('checkbox', { name, exact: true });
      const frameTree = await view.cdp.send('Page.getFrameTree');
      const flatten = tree => [tree.frame, ...(tree.childFrames ?? []).flatMap(flatten)];
      const dashboardFrame = flatten(frameTree.frameTree).find(frame => frame.url.includes('/issue-webview/dashboard.html'));
      assert.ok(dashboardFrame, 'dashboard frame is available to the Chrome accessibility tree');
      const checkedInAx = async () => {
        const tree = await view.cdp.send('Accessibility.getFullAXTree', {frameId:dashboardFrame.id});
        const matching = tree.nodes.filter(node => !node.ignored && node.role?.value === 'checkbox' && node.name?.value === name);
        assert.equal(matching.length,1,`Chrome accessibility tree must contain checkbox ${name}`);
        return matching[0].properties?.find(property => property.name === 'checked')?.value?.value;
      };
      assert.equal(await checkbox.count(), 1);
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(String(await checkedInAx()), 'false');
      await row.locator('label').click();
      assert.equal(await checkbox.isChecked(), true);
      assert.equal(String(await checkedInAx()), 'true');
      await checkbox.focus(); await view.page.keyboard.press('Space');
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(String(await checkedInAx()), 'false');
      assert.equal(view.errors.length, 0); assert.equal(view.network.length, 0);
      return { name, labelClick: 'checked', space: 'unchecked' };
    } finally { await view.context.close(); }
  });
  await run('SVG keyboard focus, selection, stable update and removal', async () => {
    const view = await mount(browser, files, 1440, false, 'no-preference');
    try {
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot;
        const nodes = snapshot.issues.slice(0, 3).map(issue => ({ id:`project:${issue.project_id}:issue:${issue.iid}`,
          sourceIds:[], kind:'issue', namespacePath:`fixture/team/service-${String(issue.project_id).padStart(2,'0')}`,
          projectId:issue.project_id, iid:String(issue.iid), title:issue.title, state:'opened', labels:[], assignees:[],
          boardIds:[], assignedToMe:true, isRoot:true, relationsStatus:'ready' }));
        snapshot.issueGraph = { connectedScope:snapshot.connectedScope, status:'ready', roots:nodes.map(node => node.id),
          nodes, edges:[], boardIssueIds:{}, boardStatus:{}, errors:[], updatedAt:Date.now() };
        snapshot.issueGraphVersion = 1; window.__host.publish();
      });
      await view.dashboard.locator('.developer-view-switch button').filter({hasText:'圖譜'}).click();
      const nodes = view.dashboard.locator('.graph-node'); await nodes.first().waitFor();
      const first = nodes.first(); await first.focus();
      assert.equal(await first.evaluate(e => e === e.ownerDocument.activeElement), true);
      assert.equal(await first.getAttribute('tabindex'), '0');
      assert.equal(await first.locator('.graph-node-focus-ring').evaluate(e => getComputedStyle(e).visibility), 'visible');
      await view.page.keyboard.press('Tab');
      assert.equal(await nodes.nth(1).evaluate(e => e === e.ownerDocument.activeElement), true);
      await view.page.keyboard.press('Shift+Tab');
      assert.equal(await first.evaluate(e => e === e.ownerDocument.activeElement), true);
      await view.page.keyboard.press('Enter');
      assert.equal(await first.getAttribute('aria-pressed'), 'true');
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot;
        snapshot.issueGraph = {...snapshot.issueGraph, nodes:[...snapshot.issueGraph.nodes]};
        snapshot.issueGraphVersion++; window.__host.publish();
      });
      assert.equal(await first.evaluate(e => e === e.ownerDocument.activeElement), true, 'stable node must retain focus');
      await view.page.keyboard.press('Tab'); await view.page.keyboard.press('Space');
      assert.equal(await nodes.nth(1).getAttribute('aria-pressed'), 'true');
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot, graph = snapshot.issueGraph;
        const remaining = graph.nodes.filter((_, index) => index !== 1);
        snapshot.issueGraph = {...graph, nodes:remaining, roots:remaining.map(node => node.id)};
        snapshot.issueGraphVersion++; window.__host.publish();
      });
      await view.page.waitForTimeout(100);
      const afterRemoval = await view.dashboard.locator('body').evaluate(body => ({
        active: body.ownerDocument.activeElement?.outerHTML.slice(0, 400), nodes: body.querySelectorAll('.graph-node').length,
        toolbarFocused: body.querySelector('.issue-graph-toolbar button') === body.ownerDocument.activeElement
      }));
      assert.equal(afterRemoval.toolbarFocused, true, `removed focused node must return focus to the graph toolbar: ${JSON.stringify(afterRemoval)}`);
      await nodes.first().focus();
      await view.page.evaluate(() => {
        const snapshot=window.__host.fixture.snapshot, issue=snapshot.issues[0];
        snapshot.issues=Array.from({length:501},(_,index)=>({...issue,id:20000+index,project_id:1,iid:index+1,title:`Canvas Issue ${index+1}`}));
        const large=snapshot.issues.map(item=>({id:`project:1:issue:${item.iid}`,sourceIds:[],kind:'issue',namespacePath:'fixture/team/service-01',
          projectId:1,iid:String(item.iid),title:item.title,state:'opened',labels:[],assignees:[],boardIds:[],assignedToMe:true,isRoot:true,relationsStatus:'ready'}));
        snapshot.issueGraph={...snapshot.issueGraph,nodes:large,roots:large.map(item=>item.id),edges:[]};
        snapshot.issueGraphVersion++;window.__host.publish();
      });
      const canvas=view.dashboard.locator('.issue-graph-canvas');await canvas.waitFor({timeout:10000});
      assert.equal(await view.dashboard.locator('.issue-graph-toolbar button').first().evaluate(e=>e===e.ownerDocument.activeElement),true,
        'switching from a focused SVG node to Canvas must return focus to the toolbar');
      await canvas.focus();await view.page.keyboard.press('End');
      await view.dashboard.locator('.graph-selected-detail h2').filter({hasText:'Canvas Issue 501'}).waitFor();
      await view.page.emulateMedia({reducedMotion:'reduce'});
      await view.dashboard.locator('.graph-animation-toggle input:disabled').waitFor();
      assert.match(await view.dashboard.locator('.graph-animation-toggle').innerText(),/系統已減少動態效果/);
      await view.page.emulateMedia({reducedMotion:'no-preference'});
      await view.dashboard.locator('.graph-animation-toggle input:not(:disabled)').waitFor();
      assert.equal(view.errors.length, 0); assert.equal(view.network.length, 0);
      await view.page.screenshot({path:path.join(output,'graph-after-removal.png')});
      return { tab: true, shiftTab: true, enter: true, space: true, focusPreserved: true, focusReturned: true, svgToCanvas: true, canvasEnd: true, reducedMotion: true };
    } finally { await view.context.close(); }
  });
  for (const mode of ['clone', 'developer']) await run(`${mode}: bounded rows, pinned focus, deletion and empty fallback`, async () => {
    const count = 300;
    fixture.snapshot.projects = mode === 'clone' ? Array.from({length:count}, (_, i) => ({...originalProjects[0], id:i+1,
      name:`scale-${i+1}`, path:`scale-${i+1}`, path_with_namespace:`fixture/team/scale-${i+1}`})) : originalProjects;
    fixture.snapshot.issues = mode === 'developer' ? Array.from({length:count}, (_, i) => ({...originalIssues[0],
      id:10000+i, project_id:1, iid:i+1, title:`Scale issue ${i+1}`})) : originalIssues;
    let view;
    try {
      view = await mount(browser, files, 1440, false, 'reduce'); await navigate(view, mode);
      const list = view.dashboard.locator(mode === 'clone' ? '.repo-list' : '.work-list');
      const rowSelector = mode === 'clone' ? '.repo-row' : '.work-row';
      await view.page.waitForTimeout(300);
      const initialCount = await list.locator(rowSelector).count();
      assert.ok(initialCount <= 60, `mounted ${initialCount} rows`);
      const first = list.locator(rowSelector).first();
      const focused = mode === 'clone' ? first.locator('input') : first;
      await focused.focus();
      await list.evaluate(e => { e.scrollTop = e.scrollHeight; }); await view.page.waitForTimeout(300);
      assert.equal(await focused.evaluate(e => e === e.ownerDocument.activeElement), true, 'scrolling must retain focus');
      assert.ok(await list.locator(rowSelector).count() <= 61, 'only the focused row may be pinned');
      await view.page.evaluate(mode => {
        const snapshot = window.__host.fixture.snapshot;
        if (mode === 'clone') snapshot.projects = snapshot.projects.slice(1);
        else snapshot.issues = snapshot.issues.slice(1);
        window.__host.publish();
      }, mode);
      await view.page.waitForTimeout(300);
      const afterRemoval = await list.evaluate(e => ({ activeIndex:e.ownerDocument.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex,
        activeText:e.ownerDocument.activeElement?.closest('.repo-row, .work-row')?.textContent, scrollTop:e.scrollTop }));
      assert.equal(afterRemoval.activeIndex, '0', JSON.stringify(afterRemoval));
      assert.match(afterRemoval.activeText, mode === 'clone' ? /scale-2/ : /Scale issue 2/);
      await view.page.evaluate(mode => {
        const snapshot = window.__host.fixture.snapshot;
        if (mode === 'clone') snapshot.projects = []; else snapshot.issues = [];
        window.__host.publish();
      }, mode);
      await view.page.waitForTimeout(300);
      const search = view.dashboard.getByLabel(mode === 'clone' ? '搜尋 Repo' : '搜尋 Issue', {exact:true});
      assert.equal(await search.evaluate(e => e === e.ownerDocument.activeElement), true, 'empty list must return focus to search');
      assert.equal(view.errors.length, 0); assert.equal(view.network.length, 0);
      return { initialCount, pinnedFocus: true, afterRemoval, emptyFallback: true };
    } finally {
      await view?.context.close(); fixture.snapshot.projects = originalProjects; fixture.snapshot.issues = originalIssues;
    }
  });
  for (const mode of ['clone','developer']) await run(`${mode}: 200/201 boundary and stable scroll anchor`, async () => {
    fixture.snapshot.projects=mode==='clone'?Array.from({length:200},(_,index)=>({...originalProjects[0],id:index+1,
      name:`scale-${index+1}`,path:`scale-${index+1}`,path_with_namespace:`fixture/group/scale-${index+1}`})):originalProjects;
    fixture.snapshot.issues=mode==='developer'?Array.from({length:200},(_,index)=>({...originalIssues[0],id:10000+index,
      project_id:1,iid:index+1,title:`Scale issue ${index+1}`})):originalIssues;
    let view;
    try {
      view=await mount(browser,files,1440,false,'reduce');await navigate(view,mode);
      const list=view.dashboard.locator(mode==='clone'?'.repo-list':'.work-list');
      const rows=list.locator('.virtual-list-row');
      assert.equal(await rows.count(),200);
      await list.evaluate(element=>{element.scrollTop=element.scrollHeight*.42;});await view.page.waitForTimeout(250);
      const anchor=()=>list.evaluate(element=>{
        const top=element.getBoundingClientRect().top;
        const row=[...element.querySelectorAll('.virtual-list-row')].find(item=>item.getBoundingClientRect().bottom>top+1);
        return {key:row?.getAttribute('data-virtual-key'),offset:row?.getBoundingClientRect().top-top,scrollTop:element.scrollTop};
      });
      const before=await anchor();
      await view.page.evaluate(mode=>{
        const snapshot=window.__host.fixture.snapshot;
        if(mode==='clone')snapshot.projects=[...snapshot.projects,{...snapshot.projects[0],id:201,name:'scale-201',path:'scale-201',path_with_namespace:'fixture/group/scale-201'}];
        else snapshot.issues=[...snapshot.issues,{...snapshot.issues[0],id:10200,iid:201,title:'Scale issue 201'}];
        window.__host.publish();
      },mode);
      await view.page.waitForTimeout(400);
      const windowed=await anchor();
      assert.ok(await rows.count()<=60,`201 rows mounted ${await rows.count()}`);
      assert.equal(windowed.key,before.key,JSON.stringify({before,windowed}));
      assert.ok(Math.abs(windowed.offset-before.offset)<4,JSON.stringify({before,windowed}));
      await view.page.evaluate(mode=>{
        const snapshot=window.__host.fixture.snapshot;
        if(mode==='clone')snapshot.projects=snapshot.projects.slice(0,200);else snapshot.issues=snapshot.issues.slice(0,200);
        window.__host.publish();
      },mode);
      await view.page.waitForTimeout(400);
      const restored=await anchor();
      assert.equal(await rows.count(),200);
      assert.equal(restored.key,before.key,JSON.stringify({before,restored}));
      assert.ok(Math.abs(restored.offset-before.offset)<4,JSON.stringify({before,restored}));
      assert.equal(view.errors.length,0);assert.equal(view.network.length,0);
      return {before,windowed,restored};
    } finally {await view?.context.close();fixture.snapshot.projects=originalProjects;fixture.snapshot.issues=originalIssues;}
  });
} finally {
  await browser?.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive:true, force:true });
}
if (results.some(entry => entry.status !== 'PASS')) process.exitCode = 1;
