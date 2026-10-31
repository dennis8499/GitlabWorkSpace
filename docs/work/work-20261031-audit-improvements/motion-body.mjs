// Appended to the packaged-UI fixture by motion-runner.py; fake isolated host only.
await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-ui-motion-'));
let browser;
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({ headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const view = await mount(browser, files, 800, false, 'no-preference');
  await view.context.tracing.start({ screenshots:true, snapshots:true, sources:false });
  const frames = [];
  const pendingFrameWrites = new Set();
  const cdp = await view.context.newCDPSession(view.page);
  await cdp.send('Page.enable');
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    try {
      await cdp.send('Page.screencastFrameAck', {sessionId});
      if (frames.length < 300) {
        const name = `frame-${String(frames.length).padStart(3,'0')}.jpg`;
        frames.push({ name, timestamp:metadata.timestamp });
        const task = writeFile(path.join(output,name), Buffer.from(data,'base64'));
        pendingFrameWrites.add(task); await task; pendingFrameWrites.delete(task);
      }
    } catch { /* The session may close while a final frame is being acknowledged. */ }
  });
  await cdp.send('Page.startScreencast', { format:'jpeg', quality:55, everyNthFrame:4 });
  const events = [];
  const record = async (action, operation) => {
    const started = Date.now();
    try { const data = await operation(); events.push({ action, status:'PASS', elapsedMs:Date.now()-started, data:data ?? null }); }
    catch (error) { events.push({ action, status:'FAIL', elapsedMs:Date.now()-started, error:error.message }); }
  };
  await record('normal motion open and close settings', async () => {
    await view.dashboard.locator('.settings-trigger').click();
    const overlay = view.dashboard.locator('.drawer-scrim'); await overlay.waitFor();
    const animation = await overlay.evaluate(element => getComputedStyle(element).animationName);
    await view.page.waitForTimeout(700);
    await view.dashboard.locator('.drawer-heading > button').click();
    await overlay.waitFor({state:'detached'}); await view.page.waitForTimeout(400);
    return {animation};
  });
  await record('rapidly reopen and close settings', async () => {
    for (let i=0; i<3; i++) {
      await view.dashboard.locator('.settings-trigger').click();
      await view.dashboard.locator('.drawer-heading > button').click();
      await view.dashboard.locator('.drawer-scrim').waitFor({state:'detached'});
    }
  });
  await record('interrupt an exiting drawer with a new open request', async () => {
    const trigger=view.dashboard.locator('.settings-trigger');
    await trigger.click();
    await view.dashboard.locator('.drawer-heading > button').click();
    // Deliberately dispatch during exit; the scrim otherwise blocks pointer input.
    await trigger.evaluate(element => element.click());
    await view.page.waitForTimeout(500);
    const overlay=view.dashboard.locator('.drawer-scrim');
    await overlay.waitFor();
    const phase=await overlay.getAttribute('data-presence');
    await view.dashboard.locator('.drawer-heading > button').click();
    await overlay.waitFor({state:'detached'});
    return {phase,method:'programmatic click while exit scrim is present'};
  });
  await record('page and item transition', async () => {
    for (const mode of ['clone','reviewer','git','developer']) { await navigate(view, mode); await view.page.waitForTimeout(350); }
    await view.dashboard.locator('.work-row').first().click(); await view.page.waitForTimeout(500);
  });
  await record('change reduced motion while running', async () => {
    await view.page.emulateMedia({ reducedMotion:'reduce' });
    await view.dashboard.locator('.settings-trigger').click();
    const overlay = view.dashboard.locator('.drawer-scrim'); await overlay.waitFor();
    const animation = await overlay.evaluate(element => getComputedStyle(element).animationName);
    if (animation !== 'none') throw new Error(`Reduced motion expected animation none, got ${animation}`);
    await view.page.waitForTimeout(500); await view.dashboard.locator('.drawer-heading > button').click();
    await overlay.waitFor({state:'detached'}); return {animation};
  });
  await cdp.send('Page.stopScreencast');
  await Promise.all([...pendingFrameWrites]);
  const report = { scope:'Actual VSIX Webview with mock host in headless Chromium. Screencast frames and trace are not native VS Code.',
    browser:browser.version(), artifactSha256:sha256(await readFile(artifactPath)), events, frames, runtimeErrors:view.errors, blockedNetworkRequests:view.network };
  await view.context.tracing.stop({ path:path.join(output, 'motion-trace.zip') });
  await view.context.close();
  await writeFile(path.join(output, 'motion.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (events.some(event => event.status !== 'PASS') || report.runtimeErrors.length || report.blockedNetworkRequests.length) process.exitCode = 1;
} finally {
  await browser?.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temp, { recursive:true, force:true });
}
