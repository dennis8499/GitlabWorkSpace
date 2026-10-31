// Appended to the packaged UI harness by run-packaged-probe.py.
await mkdir(output, {recursive:true});
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-fix-matrix-'));
const entries = [];
let browser;
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const oldProjects = fixture.snapshot.projects;
  const names = [1,2,3].map(index => `organisation/very-long-group-name/platform/customer-service-${index}`);
  fixture.snapshot.projects = names.map((name,index) => ({...oldProjects[index], path_with_namespace:name}));
  fixture.snapshot.projectLocalRepositories = {};
  fixture.snapshot.localWorkspaceRepositories = [];
  for (const width of [430,639,640,641,800,959,960,961,1440]) for (const theme of ['dark','light','highcontrast']) {
    const view = await mount(browser, files, width, theme === 'highcontrast', 'reduce');
    try {
      if (theme === 'light') await view.dashboard.locator('body').evaluate(body => {
        body.className = 'vscode-light';
        const styles = {'--vscode-foreground':'#1e1e1e','--vscode-editor-background':'#fff','--vscode-sideBar-background':'#f3f3f3',
          '--vscode-panel-border':'#b0b0b0','--vscode-focusBorder':'#0078d4','--vscode-descriptionForeground':'#555',
          '--vscode-list-hoverBackground':'#e8e8e8','--vscode-list-activeSelectionBackground':'#0060c0'};
        for (const [key,value] of Object.entries(styles)) body.ownerDocument.documentElement.style.setProperty(key,value);
      });
      for (const zoom of [1,2]) {
        await view.dashboard.locator('body').evaluate((body, value) => { body.ownerDocument.documentElement.style.zoom = String(value); }, zoom);
        for (const mode of ['clone','developer','reviewer']) {
          const entry = {width,theme,zoom,mode,status:'RUNNING'}; entries.push(entry);
          try {
            await navigate(view, mode);
            const label = mode === 'clone' ? '搜尋 Repo' : mode === 'developer' ? '搜尋 Issue' : '搜尋 MR';
            const search = view.dashboard.getByLabel(label,{exact:true});
            const before = await search.boundingBox(); await search.focus();
            entry.focus = await search.evaluate(input => {
              const style = getComputedStyle(input), r = input.getBoundingClientRect();
              return {visible:input.matches(':focus-visible'),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,
                rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
            });
            assert.equal(entry.focus.visible,true);
            assert.notEqual(entry.focus.outlineStyle,'none');
            assert.ok(parseFloat(entry.focus.outlineWidth) >= 1);
            const after = await search.boundingBox();
            assert.ok(Math.abs(before.x-after.x)<1 && Math.abs(before.y-after.y)<1 && Math.abs(before.width-after.width)<1 && Math.abs(before.height-after.height)<1,
              'focus changes input geometry');
            entry.layout = await view.dashboard.locator('body').evaluate(body => ({bodyWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,
              docWidth:body.ownerDocument.documentElement.clientWidth,docScrollWidth:body.ownerDocument.documentElement.scrollWidth}));
            assert.ok(entry.layout.bodyScrollWidth <= entry.layout.bodyWidth + 1, JSON.stringify(entry.layout));
            if (mode === 'clone') {
              for (const name of names) assert.equal(await view.dashboard.getByRole('checkbox',{name,exact:true}).count(),1,`missing accessible name: ${name}`);
              entry.names = await view.dashboard.locator('.repo-row strong').evaluateAll(elements => elements.map(e => ({text:e.textContent,
                clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,whiteSpace:getComputedStyle(e).whiteSpace,overflowWrap:getComputedStyle(e).overflowWrap})));
              assert.equal(entry.names.length,3);
              for (const name of entry.names) assert.ok(name.scrollWidth <= name.clientWidth + 1 && name.whiteSpace === 'normal',JSON.stringify(name));
            }
            assert.equal(view.errors.length,0); assert.equal(view.network.length,0);
            entry.status = 'PASS';
            if ((width === 430 && mode === 'clone') || (width === 1440 && zoom === 2 && mode === 'developer')) {
              entry.screenshot = `${width}-${theme}-${zoom}-${mode}.png`;
              await view.page.screenshot({path:path.join(output,entry.screenshot)});
            }
          } catch (error) {
            entry.status='FAIL'; entry.error=error.stack ?? String(error);
            entry.screenshot=`failure-${width}-${theme}-${zoom}-${mode}.png`;
            await view.page.screenshot({path:path.join(output,entry.screenshot)}).catch(()=>{});
          }
          await writeFile(path.join(output,'matrix.json'),JSON.stringify({artifactSha256:sha256(await readFile(artifactPath)),browser:browser.version(),
            scope:'Packaged Webview, synthetic data and mock Host; CSS zoom and emulated themes, not native VS Code or screen-reader testing.',cases:entries},null,2)+'\n');
        }
      }
    } finally { await view.context.close(); }
    console.log(`matrix ${width} ${theme}: ${entries.filter(e=>e.width===width&&e.theme===theme&&e.status==='PASS').length}/6 pass`);
  }
  fixture.snapshot.projects = oldProjects;
} finally {
  await browser?.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)); await rm(temp,{recursive:true,force:true});
}
if (entries.some(entry=>entry.status!=='PASS')) process.exitCode=1;
