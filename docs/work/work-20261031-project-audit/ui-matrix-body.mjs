// Appended to the real packaged-UI harness by ui-matrix-runner.py.
// Chrome is connected only to fixed fake hosts. No remote network is allowed.
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-ui-matrix-'));
let browser;
const cases = [];
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const allModes = ['developer', 'clone', 'sa', 'bmad', 'reviewer', 'git'];
  const settings = [
    ...[1440, 800].flatMap(width => allModes.map(mode => ({ width, mode, theme: 'dark', zoom: 1 }))),
    ...[430, 639, 640, 959, 960].flatMap(width => ['developer', 'clone', 'git'].map(mode => ({ width, mode, theme: 'dark', zoom: 1 }))),
    ...['light', 'highcontrast'].flatMap(theme => [800, 1440].flatMap(width => allModes.map(mode => ({ width, mode, theme, zoom: 1 })))),
    ...['developer', 'clone', 'git'].map(mode => ({ width: 1440, mode, theme: 'dark', zoom: 2 }))
  ];
  for (const item of settings) {
    const name = `${item.mode}-${item.width}-${item.theme}-zoom${item.zoom}`;
    const entry = { ...item, name, status: 'RUNNING' }; cases.push(entry);
    let view;
    try {
      view = await mount(browser, files, item.width, item.theme === 'highcontrast', 'no-preference');
      if (item.theme === 'light') await view.dashboard.locator('body').evaluate(body => {
        body.className = 'vscode-light';
        const styles = { '--vscode-foreground':'#1e1e1e', '--vscode-editor-background':'#fff', '--vscode-sideBar-background':'#f3f3f3',
          '--vscode-editorWidget-background':'#f3f3f3', '--vscode-panel-border':'#b0b0b0', '--vscode-widget-border':'#b0b0b0',
          '--vscode-focusBorder':'#0078d4', '--vscode-descriptionForeground':'#555', '--vscode-input-background':'#fff',
          '--vscode-input-foreground':'#222', '--vscode-input-border':'#888', '--vscode-list-hoverBackground':'#e8e8e8',
          '--vscode-list-activeSelectionBackground':'#0060c0', '--vscode-list-activeSelectionForeground':'#fff',
          '--vscode-textLink-foreground':'#005fb8', '--vscode-errorForeground':'#a1260d', '--vscode-editorWarning-foreground':'#895503' };
        for (const [key, value] of Object.entries(styles)) body.ownerDocument.documentElement.style.setProperty(key, value);
      });
      if (item.zoom !== 1) await view.dashboard.locator('body').evaluate((body, zoom) => { body.ownerDocument.documentElement.style.zoom = String(zoom); }, item.zoom);
      await navigate(view, item.mode);
      await view.page.evaluate(() => window.__host.idle());
      await view.page.waitForTimeout(300);
      entry.metrics = await view.dashboard.locator('body').evaluate(body => {
        const doc = body.ownerDocument;
        const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
        const controls = [...doc.querySelectorAll('button, input, select, textarea, [role="button"]')].filter(visible);
        const missingNames = controls.filter(element => {
          const id = element.getAttribute('aria-labelledby');
          return !(element.getAttribute('aria-label')?.trim() || (id && doc.getElementById(id)?.textContent?.trim()) || element.getAttribute('title')?.trim() ||
            element.labels?.length || element.textContent?.trim() || element.querySelector('svg title')?.textContent?.trim() || element.getAttribute('placeholder')?.trim());
        }).map(element => ({ tag: element.tagName, outerHTML: element.outerHTML.slice(0, 350) }));
        const outOfViewportControls = controls.filter(element => { const r=element.getBoundingClientRect(); return r.left < -1 || r.right > doc.defaultView.innerWidth + 1; })
          .slice(0,20).map(element => ({ tag:element.tagName, label:element.getAttribute('aria-label') || element.textContent?.trim().slice(0,80), rect:{left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right} }));
        return { viewport: doc.documentElement.clientWidth, scrollWidth: doc.documentElement.scrollWidth,
          bodyClientWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, overflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth + 1,
          visibleControls: controls.length, approximateMissingNames: missingNames, outOfViewportControls, mode: doc.querySelector('.page')?.dataset.mode,
          textExcerpt: body.innerText.slice(0, 1000) };
      });
      const readAx = async () => {
        const tree = await view.cdp.send('Page.getFrameTree');
        const flatten = node => [node.frame, ...(node.childFrames ?? []).flatMap(flatten)];
        const dashboardFrame = flatten(tree.frameTree).find(frame => frame.url.includes('/issue-webview/dashboard.html'));
        if (!dashboardFrame) throw new Error('Dashboard frame not found in Chrome frame tree');
        return (await view.cdp.send('Accessibility.getFullAXTree', {frameId:dashboardFrame.id})).nodes;
      };
      if (item.width === 1440 && item.theme === 'dark' && item.zoom === 1) {
        try {
          const ax = await readAx();
          const namedRoles = ['button','checkbox','textbox','combobox','searchbox','radio','switch'];
          entry.accessibilityTree = { source:'Chrome CDP Accessibility.getFullAXTree; not screen-reader testing',
            unnamedControls:ax.filter(node => !node.ignored && namedRoles.includes(node.role?.value) && !node.name?.value?.trim()).map(node => ({nodeId:node.nodeId,role:node.role?.value})) };
        } catch (error) { entry.accessibilityTree = {error:error.message}; }
      }
      await view.dashboard.locator('body').screenshot({ path: path.join(output, `${name}.png`), timeout: 10000 });
      if (item.width === 1440 && item.theme === 'dark' && item.zoom === 1 && ['developer','clone','reviewer'].includes(item.mode)) {
        const search = view.dashboard.locator('.search input');
        await search.waitFor();
        const sample = async () => search.evaluate(input => {
          const read = element => { const style = getComputedStyle(element); return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
            outlineColor: style.outlineColor, border: style.border, boxShadow: style.boxShadow, background: style.backgroundColor }; };
          return { focused: input === input.ownerDocument.activeElement, focusVisible: input.matches(':focus-visible'), input: read(input), parent: read(input.parentElement) };
        });
        entry.searchFocus = { before: await sample() };
        await search.focus();
        entry.searchFocus.after = await sample();
        await view.dashboard.locator('body').screenshot({ path: path.join(output, `${name}-search-focused.png`), timeout: 10000 });
      }
      if (item.mode === 'developer' && item.width === 1440 && item.theme === 'dark' && item.zoom === 1) {
        try {
          await view.page.evaluate(() => {
            const snapshot = window.__host.fixture.snapshot;
            const nodes = snapshot.issues.slice(0, 3).map(issue => ({ id:`project:${issue.project_id}:issue:${issue.iid}`, sourceIds:[], kind:'issue',
              namespacePath:`fixture/team/service-${String(issue.project_id).padStart(2,'0')}`, projectId:issue.project_id, iid:String(issue.iid),
              title:issue.title, state:'opened', labels:[], assignees:[], boardIds:[], assignedToMe:true, isRoot:true, relationsStatus:'ready' }));
            snapshot.issueGraph = { connectedScope:snapshot.connectedScope, status:'ready', roots:nodes.map(n => n.id), nodes, edges:[], boardIssueIds:{}, boardStatus:{}, errors:[], updatedAt:Date.now() };
            snapshot.issueGraphVersion = 1;
            window.__host.publish();
          });
          await view.dashboard.locator('.developer-view-switch button').filter({ hasText:'圖譜' }).click();
          const node = view.dashboard.locator('.graph-node').first(); await node.waitFor({timeout:5000});
          const readNode = () => node.evaluate(element => {
            const core = element.querySelector('.graph-node-core, .graph-node-sector');
            const style = target => { const s = getComputedStyle(target); return {outline:s.outline,stroke:s.stroke,strokeWidth:s.strokeWidth,filter:s.filter,opacity:s.opacity}; };
            return {focused:element === element.ownerDocument.activeElement,focusVisible:element.matches(':focus-visible'),selected:element.classList.contains('selected'),node:style(element),core:style(core)};
          });
          entry.graphFocus = {before:await readNode()};
          await view.page.keyboard.press('Tab'); await node.focus();
          entry.graphFocus.after = await readNode();
          const ax = await readAx();
          entry.graphFocus.accessibilityNodes = ax.filter(node => node.name?.value?.includes('符合篩選的主要 Issue')).map(node => ({ignored:node.ignored, role:node.role?.value, name:node.name?.value}));
          await view.dashboard.locator('body').screenshot({path:path.join(output,'developer-1440-graph-focused.png')});
        } catch (error) { entry.graphFocus = { error:error.message }; }
      }
      entry.errors = view.errors; entry.blockedNetworkRequests = view.network;
      entry.status = entry.metrics.overflow || view.errors.length || view.network.length ? 'FAIL' : 'PASS';
    } catch (error) { entry.status = 'ERROR'; entry.error = error.message; }
    finally { if (view) await view.context.close(); }
    console.log(JSON.stringify({ name, status: entry.status, overflow: entry.metrics?.overflow, unnamed: entry.metrics?.approximateMissingNames.length, error: entry.error }));
    await writeFile(path.join(output, 'matrix.json'), JSON.stringify({ schema:'GitLabWorkspaceUiAuditMatrix/v1', scope:'VSIX dashboard in headless Chromium with isolated fake host, not native VS Code; light/high-contrast colours approximated',
      browser:browser.version(), artifact:{path:artifactPath,sha256:sha256(await readFile(artifactPath))}, cases }, null, 2) + '\n');
  }
  const overlays = [];
  for (const width of [430,640,800,960,1440]) {
    for (const panel of ['issue-detail','settings','account-form','notifications']) {
      const entry = {width,panel,status:'RUNNING'}; overlays.push(entry);
      let view;
      try {
        view = await mount(browser, files, width, false, 'no-preference');
        if (panel === 'issue-detail') await view.dashboard.locator('.work-row').first().click();
        else if (panel === 'notifications') await view.dashboard.locator('.notifications-trigger').click();
        else {
          await view.dashboard.locator('.settings-trigger').click();
          if (panel === 'account-form') {
            await view.dashboard.locator('#settings-tab-accounts').click();
            await view.dashboard.locator('.accounts-heading button').click();
            await view.dashboard.locator('.account-login input[name="baseUrl"]').waitFor();
          }
        }
        await view.page.waitForTimeout(350);
        entry.layout = await view.dashboard.locator('body').evaluate(body => ({bodyWidth:body.clientWidth,scrollWidth:body.scrollWidth,overflow:body.scrollWidth>body.clientWidth+1,
          dialog:!!body.querySelector('[role="dialog"]'), focusInDialog:!!body.querySelector('[role="dialog"]')?.contains(body.ownerDocument.activeElement)}));
        await view.dashboard.locator('body').screenshot({path:path.join(output,`${panel}-${width}.png`)});
        entry.errors=view.errors; entry.blockedNetworkRequests=view.network;
        entry.status=entry.layout.overflow || view.errors.length || view.network.length ? 'FAIL':'PASS';
      } catch (error) { entry.status='ERROR'; entry.error=error.message; }
      finally { if (view) await view.context.close(); }
      console.log(JSON.stringify(entry));
      await writeFile(path.join(output,'matrix.json'),JSON.stringify({schema:'GitLabWorkspaceUiAuditMatrix/v1',scope:'VSIX dashboard in headless Chromium with isolated fake host, not native VS Code; light/high-contrast colours approximated',
        browser:browser.version(),artifact:{path:artifactPath,sha256:sha256(await readFile(artifactPath))},cases,overlays},null,2)+'\n');
    }
  }
  const listBoundaries=[];
  const originalProjects=fixture.snapshot.projects, originalIssues=fixture.snapshot.issues;
  for (const mode of ['clone','developer']) for (const count of [200,201]) {
    const entry={mode,count,status:'RUNNING'}; listBoundaries.push(entry); let view;
    try {
      fixture.snapshot.projects=Array.from({length:count},(_,index) => {
        const item=originalProjects[0], name=`scale-${String(index+1).padStart(4,'0')}`;
        return {...item,id:index+1,name,path:name,path_with_namespace:`fixture/team/${name}`};
      });
      fixture.snapshot.issues=Array.from({length:count},(_,index) => ({...originalIssues[0],id:10000+index,project_id:1,iid:index+1,title:`Scale issue ${index+1}`}));
      view=await mount(browser,files,1440,false,'reduce'); await navigate(view,mode);
      const list=view.dashboard.locator(mode==='clone'?'.repo-list':'.work-list');
      const selector=mode==='clone'?'.repo-row':'.work-row';
      const label=mode==='clone'?`scale-${String(count).padStart(4,'0')}`:`Scale issue ${count}`;
      entry.renderedAtTop=await list.locator(selector).count();
      entry.countLabel=mode==='clone'?await view.dashboard.locator('.clone-list-column .count').innerText():null;
      await list.evaluate(element => {element.scrollTop=element.scrollHeight;});
      await view.page.waitForTimeout(400);
      entry.renderedAtBottom=await list.locator(selector).count();
      entry.lastItemVisible=await list.locator(selector).filter({hasText:label}).count() > 0;
      await view.dashboard.locator('body').screenshot({path:path.join(output,`list-${mode}-${count}-bottom.png`)});
      entry.status=entry.lastItemVisible && (count===200 ? entry.renderedAtTop===200 : entry.renderedAtTop<201) && !view.errors.length && !view.network.length ? 'PASS':'FAIL';
      entry.errors=view.errors; entry.blockedNetworkRequests=view.network;
    } catch(error) {entry.status='ERROR';entry.error=error.message;}
    finally {if(view) await view.context.close();fixture.snapshot.projects=originalProjects;fixture.snapshot.issues=originalIssues;}
    console.log(JSON.stringify(entry));
    await writeFile(path.join(output,'matrix.json'),JSON.stringify({schema:'GitLabWorkspaceUiAuditMatrix/v1',scope:'VSIX dashboard in headless Chromium with isolated fake host, not native VS Code; light/high-contrast colours approximated',
      browser:browser.version(),artifact:{path:artifactPath,sha256:sha256(await readFile(artifactPath))},cases,overlays,listBoundaries},null,2)+'\n');
  }
} finally {
  await browser?.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
