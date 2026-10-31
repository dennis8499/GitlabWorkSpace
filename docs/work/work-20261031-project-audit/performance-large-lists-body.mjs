await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-audit-large-list-'));
let browser;
const artifactSha256 = sha256(await readFile(artifactPath));
const results = [];
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({ headless: true, executablePath: args.browser ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const originalProjects = fixture.snapshot.projects, originalIssues = fixture.snapshot.issues;
  const cases = args.cases ? new Set(args.cases.split(',')) : null;
  for (const [mode, count, rounds] of [['clone', 200, 3], ['clone', 201, 3], ['clone', 2000, 3],
      ['developer', 200, 3], ['developer', 201, 3], ['developer', 2000, 3], ['developer', 10000, 1]]) {
    if (cases && !cases.has(`${mode}:${count}`)) continue;
    const cssControl = args['css-control'] === 'true';
    const runCount = cases && !cssControl ? 1 : rounds;
    for (let run = 1; run <= runCount; run++) {
      let view;
      const entry = { mode, count, run, status: 'RUNNING' };
      const caseStarted = performance.now();
      results.push(entry);
      console.log(`large-list ${mode} ${count} run ${run}/${runCount}`);
      try {
        fixture.snapshot.projects = mode === 'clone' ? Array.from({ length: count }, (_, i) => ({ ...originalProjects[0],
          id: i + 1, name: i === 0 ? 'unique-target' : `scale-${String(i + 1).padStart(5, '0')}`,
          path: i === 0 ? 'unique-target' : `scale-${String(i + 1).padStart(5, '0')}`,
          path_with_namespace: i === 0 ? 'fixture/team/unique-target' : `fixture/team/scale-${String(i + 1).padStart(5, '0')}` })) : originalProjects;
        fixture.snapshot.issues = mode === 'developer' ? Array.from({ length: count }, (_, i) => ({ ...originalIssues[0],
          id: 10000 + i, project_id: 1, iid: i + 1, title: i === 0 ? 'unique-target' : `Scale issue ${i + 1}` })) : originalIssues;
        const mountStart = performance.now();
        view = await mount(browser, files, 1440, false, 'reduce');
        entry.mountWallMs = round(performance.now() - mountStart);
        await view.cdp.send('Performance.enable');
        await navigate(view, mode === 'clone' ? 'developer' : 'clone');
        await view.page.evaluate(() => {
          const win = document.getElementById('dashboard').contentWindow;
          win.__auditLongTasks = [];
          win.__auditObserver = new win.PerformanceObserver(list => win.__auditLongTasks.push(...list.getEntries().map(x => ({ start: x.startTime, duration: x.duration }))));
          win.__auditObserver.observe({ type: 'longtask', buffered: false });
        });
        entry.navigateFeedbackMs = await navigate(view, mode);
        await view.page.waitForTimeout(1000);
        const listSelector = mode === 'clone' ? '.repo-list' : '.work-list';
        const rowSelector = mode === 'clone' ? '.repo-row' : '.work-row';
        const inputLabel = mode === 'clone' ? '搜尋 Repo' : '搜尋 Issue';
        if (cssControl) {
          await view.dashboard.locator(listSelector).evaluate(element => { element.style.maxHeight = '600px'; });
          await view.page.waitForTimeout(1000);
        }
        entry.cssControl = cssControl ? 'temporary max-height:600px applied only in test browser' : null;
        entry.dom = await view.dashboard.locator(listSelector).evaluate((el, row) => ({ rowsMounted: el.querySelectorAll(row).length,
          totalDomNodes: el.ownerDocument.getElementsByTagName('*').length, listClientHeight: el.clientHeight, listScrollHeight: el.scrollHeight,
          pageClientHeight: el.closest('.page')?.clientHeight, pageScrollHeight: el.closest('.page')?.scrollHeight }), rowSelector);
        entry.navigationLongTasks = await view.page.evaluate(() => {
          const win = document.getElementById('dashboard').contentWindow;
          win.__auditLongTasks.push(...win.__auditObserver.takeRecords().map(x => ({ start: x.startTime, duration: x.duration })));
          win.__auditObserver.disconnect();
          return win.__auditLongTasks;
        });
        entry.heapAfterNavigation = await heap(view, 'after-navigation-gc');
        await view.page.evaluate(() => {
          const win = document.getElementById('dashboard').contentWindow;
          win.__auditLongTasks = [];
          win.__auditObserver.observe({ type: 'longtask', buffered: false });
        });
        const durations = await view.page.evaluate(async ({ mode, count, samples, cssControl }) => {
          const win = document.getElementById('dashboard').contentWindow, doc = win.document;
          const input = doc.querySelector(`input[aria-label="${mode === 'clone' ? '搜尋 Repo' : '搜尋 Issue'}"]`);
          const row = mode === 'clone' ? '.repo-list .repo-row' : '.work-list .work-row';
          if (!input) throw new Error('search input not found');
          const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set;
          const raf = () => new Promise(resolve => win.requestAnimationFrame(resolve));
          const result = { narrow: [], reset: [], scroll: [] };
          for (let i = 0; i < samples; i++) {
            for (const [query, label] of [['unique-target', 'narrow'], ['', 'reset']]) {
              const start = win.performance.now();
              setter.call(input, query); input.dispatchEvent(new win.Event('input', { bubbles: true }));
              while (label === 'narrow' ? doc.querySelectorAll(row).length !== 1 : doc.querySelectorAll(row).length < 2) {
                if (win.performance.now() - start > 30000) throw new Error(`search ${label} did not render the expected visible results`);
                await raf();
              }
              await raf(); await raf();
              result[label].push(win.performance.now() - start);
            }
          }
          const page = doc.querySelector(cssControl ? (mode === 'clone' ? '.repo-list' : '.work-list') : '.page');
          for (let i = 0; i < 30; i++) {
            const start = win.performance.now();
            page.scrollTop = i % 2 ? 0 : page.scrollHeight;
            await raf(); await raf();
            result.scroll.push(win.performance.now() - start);
          }
          return result;
        }, { mode, count, samples: count >= 10000 ? 3 : 10, cssControl });
        entry.searchNarrowMs = durations.narrow;
        entry.searchResetMs = durations.reset;
        entry.pageScrollMs = durations.scroll;
        entry.interactionLongTasks = await view.page.evaluate(() => {
          const win = document.getElementById('dashboard').contentWindow;
          win.__auditLongTasks.push(...win.__auditObserver.takeRecords().map(x => ({ start: x.startTime, duration: x.duration })));
          win.__auditObserver.disconnect();
          return win.__auditLongTasks;
        });
        entry.longTasks = [...entry.navigationLongTasks, ...entry.interactionLongTasks];
        entry.heapAfterInteractions = await heap(view, 'after-interactions-gc');
        const metrics = await view.cdp.send('Performance.getMetrics');
        entry.rendererMetrics = Object.fromEntries(metrics.metrics.filter(x => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'Nodes', 'JSEventListeners'].includes(x.name)).map(x => [x.name, x.value]));
        entry.errors = view.errors; entry.blockedNetworkRequests = view.network;
        entry.status = view.errors.length || view.network.length ? 'ERROR' : 'PASS';
      } catch (error) {
        entry.status = 'ERROR'; entry.error = error.message;
      } finally {
        entry.elapsedWallMs = round(performance.now() - caseStarted);
        if (view) await view.context.close().catch(() => {});
        fixture.snapshot.projects = originalProjects; fixture.snapshot.issues = originalIssues;
      }
      const report = { schema: 'GitLabWorkspaceLargeListPerformanceAudit/v1', artifactSha256, browser: browser.version(),
        scope: 'Actual VSIX dashboard assets in Chromium with mock Host and synthetic data; no VS Code or GitLab.',
        method: `Fresh context per round. Search uses scripted DOM input to matching narrowed or restored visible rows and two animation frames; scroll uses ${cssControl ? 'the temporary bounded list' : 'the actual outer page'} scrollTop to two animation frames. ${cssControl ? 'Temporary max-height:600px is a diagnostic intervention, not shipped CSS or a validated fix. ' : ''}Heap is shared renderer V8 heap after GC, not process memory. Runtime/CDP automation overhead and fixture scale are not production server measurements.`,
        cases: results };
      await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ mode, count, run, status: entry.status, error: entry.error, dom: entry.dom,
        narrowMedianMs: entry.searchNarrowMs?.length ? round(percentile(entry.searchNarrowMs, .5)) : null,
        resetMedianMs: entry.searchResetMs?.length ? round(percentile(entry.searchResetMs, .5)) : null,
        scrollP95Ms: entry.pageScrollMs?.length ? round(percentile(entry.pageScrollMs)) : null,
        longTasks: entry.longTasks?.length, maxLongTaskMs: entry.longTasks?.length ? Math.max(...entry.longTasks.map(x => x.duration)) : 0 }));
    }
  }
} finally {
  await browser?.close().catch(() => {});
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive: true, force: true });
}
