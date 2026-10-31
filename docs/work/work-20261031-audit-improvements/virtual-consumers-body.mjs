// Appended to the packaged UI harness by run-packaged-probe.py.
// Exercises other VirtualRows consumers with a fixed mock Host and VSIX assets.
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-virtual-consumers-'));
const results = [];
let browser;
const run = async (name, action) => {
  const entry = { name, status: 'RUNNING' }; results.push(entry);
  try { entry.detail = await action(); entry.status = 'PASS'; }
  catch (error) { entry.status = 'FAIL'; entry.error = error.stack ?? String(error); }
  await writeFile(path.join(output, 'consumers.json'), JSON.stringify({
    artifactSha256: sha256(await readFile(artifactPath)), browser: browser.version(),
    scope: 'Packaged VSIX Webview, synthetic data and mock Host in Chromium; not native VS Code or GitLab.', cases: results
  }, null, 2) + '\n');
  console.log(`${entry.status} ${name}${entry.error ? ': ' + entry.error.split('\n')[0] : ''}`);
};
const anchor = list => list.evaluate(element => {
  const top = element.getBoundingClientRect().top;
  const row = [...element.querySelectorAll('.virtual-list-row')].find(item => item.getBoundingClientRect().bottom > top + 1);
  return { key: row?.getAttribute('data-virtual-key'), offset: row?.getBoundingClientRect().top - top, scrollTop: element.scrollTop };
});
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ignoreDefaultArgs: ['--hide-scrollbars'] });
  const originalProjects = fixture.snapshot.projects, originalIssues = fixture.snapshot.issues, originalMrs = fixture.snapshot.mergeRequests;
  await run('MR 200/201 boundary, scrolling and full-data keyboard navigation', async () => {
    fixture.snapshot.mergeRequests = Array.from({length:200}, (_, index) => ({...originalMrs[0],
      id:20000 + index, project_id:1, iid:index + 1, title:`MR scale ${index + 1}`}));
    let view;
    try {
      view = await mount(browser, files, 1440, false, 'reduce'); await navigate(view, 'reviewer');
      const list = view.dashboard.locator('.work-list'), rows = list.locator('.virtual-list-row');
      assert.equal(await rows.count(), 200);
      await list.evaluate(element => { element.scrollTop = element.scrollHeight * .42; });
      await view.page.waitForTimeout(250);
      const before = await anchor(list);
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot;
        snapshot.mergeRequests = [...snapshot.mergeRequests, {...snapshot.mergeRequests[0], id:20200, iid:201, title:'MR scale 201'}];
        window.__host.publish();
      });
      await view.page.waitForTimeout(400);
      const windowed = await anchor(list);
      assert.ok(await rows.count() <= 60, `201 MR rows mounted ${await rows.count()}`);
      assert.equal(windowed.key, before.key, JSON.stringify({before,windowed}));
      assert.ok(Math.abs(windowed.offset - before.offset) < 4, JSON.stringify({before,windowed}));
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot;
        snapshot.mergeRequests = snapshot.mergeRequests.slice(0, 200); window.__host.publish();
      });
      await view.page.waitForTimeout(400);
      const restored = await anchor(list);
      assert.equal(await rows.count(), 200);
      assert.equal(restored.key, before.key, JSON.stringify({before,restored}));
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot, first = snapshot.mergeRequests[0];
        snapshot.mergeRequests = Array.from({length:1000}, (_, index) => ({...first,id:20000+index,iid:index+1,title:`MR scale ${index+1}`}));
        window.__host.publish();
      });
      await view.page.waitForTimeout(500);
      assert.ok(await rows.count() <= 60);
      await list.hover();
      const oldTop = await list.evaluate(element => element.scrollTop);
      await view.page.mouse.wheel(0, 300); await view.page.waitForTimeout(200);
      const wheelTop = await list.evaluate(element => element.scrollTop);
      assert.ok(wheelTop > oldTop, JSON.stringify({oldTop,wheelTop}));
      await list.evaluate(element => {
        const bounds=element.getBoundingClientRect();
        const visible=[...element.querySelectorAll('.work-row')].find(row => {
          const rect=row.getBoundingClientRect();return rect.top>=bounds.top && rect.bottom<=bounds.bottom;
        });
        if(!visible) throw new Error('No fully visible MR row to focus');
        visible.focus();
      });
      await view.page.waitForTimeout(100);
      await view.page.keyboard.press('End');
      await list.locator('[data-virtual-index="999"] .work-row').waitFor({timeout:5000});
      const activeIndex = () => list.evaluate(element => element.ownerDocument.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex);
      assert.equal(await activeIndex(), '999');
      await view.page.keyboard.press('ArrowUp'); await view.page.waitForTimeout(150); assert.equal(await activeIndex(), '998');
      await view.page.keyboard.press('Home'); await view.page.waitForTimeout(150); assert.equal(await activeIndex(), '0');
      await view.page.keyboard.press('ArrowDown'); await view.page.waitForTimeout(150); assert.equal(await activeIndex(), '1');
      await view.page.keyboard.press('End'); await view.page.waitForTimeout(150); await view.page.keyboard.press('Enter');
      await view.dashboard.locator('.reviewer-detail').getByText('MR scale 1000', {exact:false}).first().waitFor();
      assert.equal(view.errors.length, 0); assert.equal(view.network.length, 0);
      return {before, windowed, restored, mounted:await rows.count(), wheelDelta:wheelTop-oldTop,
        keyboard:'End, ArrowUp, Home, ArrowDown and Enter selected the last MR'};
    } finally { await view?.context.close(); fixture.snapshot.mergeRequests = originalMrs; }
  });
  for (const mode of ['clone','developer','reviewer']) await run(`${mode}: operate last item and recover focus when it is removed`, async () => {
    if (mode === 'clone') fixture.snapshot.projects = Array.from({length:300}, (_, index) => ({...originalProjects[0],
      id:index+1, name:`scale-${index+1}`, path:`scale-${index+1}`, path_with_namespace:`fixture/team/scale-${index+1}`}));
    if (mode === 'developer') fixture.snapshot.issues = Array.from({length:300}, (_, index) => ({...originalIssues[0],
      id:10000+index, project_id:1, iid:index+1, title:`Scale issue ${index+1}`}));
    if (mode === 'reviewer') fixture.snapshot.mergeRequests = Array.from({length:300}, (_, index) => ({...originalMrs[0],
      id:20000+index, project_id:1, iid:index+1, title:`MR scale ${index+1}`}));
    let view;
    try {
      view = await mount(browser, files, 1440, false, 'reduce'); await navigate(view, mode);
      const list = view.dashboard.locator(mode === 'clone' ? '.repo-list' : '.work-list');
      await list.hover(); await view.page.mouse.wheel(0, 100000); await view.page.waitForTimeout(300);
      await list.locator('[data-virtual-index="299"]').waitFor();
      const track = await list.evaluate(element => {
        const style = getComputedStyle(element);
        return {width:element.offsetWidth-element.clientWidth-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth),
          borderRight:parseFloat(style.borderRightWidth),borderTop:parseFloat(style.borderTopWidth)};
      });
      let scrollbar = 'unavailable in this Chromium environment';
      if (track.width >= 5) {
        await list.evaluate(element => {element.scrollTop=0;}); await view.page.waitForTimeout(200);
        const box = await list.boundingBox();
        const x = box.x+box.width-track.borderRight-track.width/2;
        await view.page.mouse.move(x,box.y+track.borderTop+7); await view.page.mouse.down();
        await view.page.mouse.move(x,box.y+box.height-5,{steps:10}); await view.page.mouse.up();
        await view.page.waitForTimeout(350);
        const position = await list.evaluate(element => ({top:element.scrollTop,max:element.scrollHeight-element.clientHeight}));
        if (position.top >= position.max*.95) {
          await list.locator('[data-virtual-index="299"]').waitFor(); scrollbar = 'dragged to end';
        } else scrollbar = {status:'BLOCKED',position,
          reason:'Headless Chromium also failed to drag a standalone native scrollbar; see scrollbar-diagnostic.'};
      }
      const first = list.locator(mode === 'clone' ? '.repo-row input' : '.work-row').first();
      await first.focus(); await view.page.keyboard.press('End'); await view.page.waitForTimeout(250);
      const lastRow = list.locator('[data-virtual-index="299"]'); await lastRow.waitFor();
      if (mode === 'clone') {
        const checkbox = lastRow.locator('input'); assert.equal(await checkbox.isChecked(), false);
        await view.page.keyboard.press('Space'); assert.equal(await checkbox.isChecked(), true);
      } else {
        await view.page.keyboard.press('Enter');
        await view.page.waitForFunction(mode => {
          const snapshot = window.__host.fixture.snapshot;
          return mode === 'developer' ? snapshot.selectedIssue?.issue?.iid === 300 : snapshot.selectedMergeRequest?.request?.iid === 300;
        }, mode);
      }
      await (mode === 'clone' ? lastRow.locator('input') : lastRow.locator('button')).focus();
      await view.page.evaluate(mode => {
        const snapshot = window.__host.fixture.snapshot;
        const key = mode === 'clone' ? 'projects' : mode === 'developer' ? 'issues' : 'mergeRequests';
        snapshot[key] = snapshot[key].slice(0, -1); window.__host.publish();
      }, mode);
      await view.page.waitForTimeout(350);
      const active = await list.evaluate(element => ({index:element.ownerDocument.activeElement?.closest('[data-virtual-index]')?.dataset.virtualIndex,
        text:element.ownerDocument.activeElement?.closest('.repo-row, .work-row')?.textContent}));
      assert.equal(active.index, '298', JSON.stringify(active));
      assert.match(active.text, mode === 'clone' ? /scale-299/ : mode === 'developer' ? /Scale issue 299/ : /MR scale 299/);
      assert.equal(view.errors.length,0); assert.equal(view.network.length,0);
      return {wheelReachedEnd:true,scrollbar,lastActivated:true,focusAfterRemoval:active};
    } finally {
      await view?.context.close(); fixture.snapshot.projects = originalProjects;
      fixture.snapshot.issues = originalIssues; fixture.snapshot.mergeRequests = originalMrs;
    }
  });
  for (const mode of ['clone','developer']) await run(`${mode}: wrapped variable heights after resize, zoom and hide/restore`, async () => {
    if (mode === 'clone') fixture.snapshot.projects = Array.from({length:300}, (_, index) => ({...originalProjects[0],
      id:index+1, name:`scale-${index+1}`, path:`scale-${index+1}`,
      path_with_namespace:`fixture/very-long-team-and-subgroup-${index%7}/service-with-a-long-name-and-distinct-ending-${index+1}`}));
    if (mode === 'developer') fixture.snapshot.issues = Array.from({length:300}, (_, index) => ({...originalIssues[0],
      id:10000+index, project_id:1, iid:index+1, title:`Issue with a long variable length title ${'word '.repeat(index%5+1)}${index+1}`,
      labels:Array.from({length:index%5},(_,item)=>`long-label-${index}-${item}`)}));
    let view;
    try {
      view = await mount(browser, files, 800, false, 'reduce'); await navigate(view, mode);
      const list = view.dashboard.locator(mode === 'clone' ? '.repo-list' : '.work-list');
      await list.evaluate(element => {element.scrollTop=element.scrollHeight*.5;}); await view.page.waitForTimeout(350);
      await view.page.setViewportSize({width:730,height:900});
      await view.page.evaluate(() => {document.getElementById('dashboard').style.width='430px';});
      await view.dashboard.locator('body').evaluate(element => {element.style.zoom='2';});
      await view.page.waitForTimeout(900);
      const geometry = () => list.evaluate(element => {
        const rows = [...element.querySelectorAll('.virtual-list-row')].map(row => ({index:Number(row.dataset.virtualIndex),
          top:row.getBoundingClientRect().top,bottom:row.getBoundingClientRect().bottom})).sort((a,b)=>a.index-b.index);
        const overlaps=[];
        for(let i=1;i<rows.length;i++) if(rows[i].index===rows[i-1].index+1 && rows[i].top < rows[i-1].bottom-1)
          overlaps.push({previous:rows[i-1],next:rows[i]});
        return {rows:rows.length,overlaps,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,
          documentWidth:element.ownerDocument.documentElement.scrollWidth,viewportWidth:element.ownerDocument.documentElement.clientWidth};
      });
      const resized = await geometry();
      assert.ok(resized.rows <= 60, JSON.stringify(resized)); assert.deepEqual(resized.overlaps, []);
      assert.ok(resized.documentWidth <= resized.viewportWidth+1, JSON.stringify(resized));
      await view.page.evaluate(() => {document.getElementById('dashboard').style.display='none';});
      await view.page.waitForTimeout(250);
      await view.page.evaluate(() => {document.getElementById('dashboard').style.display='block';});
      await view.page.waitForTimeout(900);
      const restored = await geometry(); assert.deepEqual(restored.overlaps, []);
      await list.evaluate(element => {element.scrollTop=element.scrollHeight;}); await view.page.waitForTimeout(500);
      await list.locator('[data-virtual-index="299"]').waitFor();
      const end = await geometry(); assert.deepEqual(end.overlaps, []);
      await view.page.evaluate(mode => {
        const snapshot=window.__host.fixture.snapshot,key=mode==='clone'?'projects':'issues';
        window.__savedVirtualItems=snapshot[key];snapshot[key]=snapshot[key].slice(0,200);window.__host.publish();
      },mode);
      await view.page.waitForTimeout(300);assert.equal(await list.locator('.virtual-list-row').count(),200);
      await list.evaluate(element => {element.scrollTop=element.scrollHeight*.42;});await view.page.waitForTimeout(250);
      const boundaryBefore=await anchor(list);
      await view.page.evaluate(mode=>{
        const snapshot=window.__host.fixture.snapshot,key=mode==='clone'?'projects':'issues';
        snapshot[key]=window.__savedVirtualItems.slice(0,201);window.__host.publish();
      },mode);
      await view.page.waitForTimeout(700);
      const boundaryAfter=await anchor(list);
      assert.equal(boundaryAfter.key,boundaryBefore.key,JSON.stringify({boundaryBefore,boundaryAfter}));
      assert.ok(Math.abs(boundaryAfter.offset-boundaryBefore.offset)<4,JSON.stringify({boundaryBefore,boundaryAfter}));
      assert.deepEqual((await geometry()).overlaps,[]);
      assert.equal(view.errors.length,0); assert.equal(view.network.length,0);
      return {resized,restored,end,lastReached:true,zoomBoundary:{before:boundaryBefore,after:boundaryAfter}};
    } finally {
      await view?.context.close(); fixture.snapshot.projects=originalProjects; fixture.snapshot.issues=originalIssues;
    }
  });
  await run('MR Diff expansion and scroll survive virtual unmount and hidden tab', async () => {
    let view;
    try {
      view = await mount(browser, files, 1440, false, 'reduce'); await navigate(view, 'reviewer');
      await view.dashboard.locator('.work-row').first().click();
      await view.dashboard.locator('.reviewer-detail').getByRole('tab', {name:'變更'}).waitFor();
      await view.page.evaluate(() => {
        const snapshot = window.__host.fixture.snapshot;
        snapshot.selectedMergeRequest.diffs = Array.from({length:300}, (_, index) => ({
          old_path:`src/file-${String(index+1).padStart(3,'0')}.ts`, new_path:`src/file-${String(index+1).padStart(3,'0')}.ts`,
          diff:'@@ -1 +1 @@\n-old\n+new', new_file:false, deleted_file:false, renamed_file:false
        }));
        window.__host.publish();
      });
      const list = view.dashboard.locator('.diff-list'); await list.locator('summary').first().waitFor();
      await list.locator('summary').first().click();
      assert.equal(await list.locator('details').first().getAttribute('open'), '');
      await view.dashboard.getByLabel('搜尋 MR', {exact:true}).focus();
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; }); await view.page.waitForTimeout(350);
      assert.ok(await list.locator('.virtual-list-row').count() <= 60);
      await list.evaluate(element => { element.scrollTop = 0; }); await view.page.waitForTimeout(350);
      assert.equal(await list.locator('details').first().getAttribute('open'), '', 'expanded file must remain open');
      await list.evaluate(element => { element.scrollTop = element.scrollHeight * .5; }); await view.page.waitForTimeout(350);
      const before = await anchor(list);
      await view.dashboard.getByRole('tab', {name:'討論'}).click();
      await view.dashboard.getByRole('tab', {name:'變更'}).click(); await view.page.waitForTimeout(350);
      const after = await anchor(list);
      assert.equal(after.key, before.key, JSON.stringify({before,after}));
      assert.ok(Math.abs(after.offset - before.offset) < 4, JSON.stringify({before,after}));
      assert.equal(view.errors.length, 0); assert.equal(view.network.length, 0);
      return {expandedAfterRemount:true,before,after,mounted:await list.locator('.virtual-list-row').count()};
    } finally { await view?.context.close(); }
  });
  await run('Clone operation results retain scroll after stable-ID update', async () => {
    fixture.snapshot.cloneOperation = {type:'cloneOperation',id:'fixture-clone',scopeKey:fixture.snapshot.connectedScope,
      label:'Fixture operation',phase:'completed',items:Array.from({length:300},(_,index)=>({projectId:index+1,
        projectPath:`fixture/group/repo-${String(index+1).padStart(3,'0')}`,state:'completed'}))};
    let view;
    try {
      view = await mount(browser, files, 1440, false, 'reduce'); await navigate(view, 'clone');
      const list = view.dashboard.locator('.operation-item-list'); await list.waitFor();
      assert.ok(await list.locator('.virtual-list-row').count() <= 60);
      await list.evaluate(element => {element.scrollTop = element.scrollHeight * .5;}); await view.page.waitForTimeout(350);
      const before = await anchor(list);
      await view.page.evaluate(() => {
        const operation = window.__host.fixture.snapshot.cloneOperation;
        operation.items = operation.items.map((item,index) => index === 1 ? {...item,message:'Updated result'} : item);
        window.__host.publish();
      });
      await view.page.waitForTimeout(350); const after = await anchor(list);
      assert.equal(after.key,before.key,JSON.stringify({before,after}));
      assert.ok(Math.abs(after.offset-before.offset)<4,JSON.stringify({before,after}));
      assert.equal(view.errors.length, 0); assert.equal(view.network.length, 0);
      return {before,after,mounted:await list.locator('.virtual-list-row').count()};
    } finally { await view?.context.close(); delete fixture.snapshot.cloneOperation; }
  });
} finally {
  await browser?.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive:true, force:true });
}
if (results.some(entry => entry.status !== 'PASS')) process.exitCode = 1;
