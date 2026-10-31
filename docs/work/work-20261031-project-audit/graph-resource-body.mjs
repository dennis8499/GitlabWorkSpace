// Source-based graph fixture; CDP TaskDuration is main-thread time, not OS CPU.
try {
  const destination = process.argv[2]; const measurements = [];
  for (const animate of [true, false]) {
    const page = await browser.newPage({ viewport:{width:1400,height:900} });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({type:'module',url:`http://127.0.0.1:${server.address().port}/${result.output.find(item => item.type === 'chunk' && item.isEntry).fileName}`});
    await page.waitForFunction(() => typeof window.mountGraph === 'function');
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    await page.evaluate(animate => window.mountGraph(2000, animate), animate);
    await page.locator('canvas').waitFor();
    await page.waitForTimeout(5000);
    const samples = [];
    for (let i=0; i<60; i++) {
      const { metrics } = await cdp.send('Performance.getMetrics');
      const selected = Object.fromEntries(metrics.filter(({name}) => ['Timestamp','TaskDuration','ScriptDuration','JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','Frames'].includes(name)).map(({name,value}) => [name,value]));
      samples.push({ second:i, workers:page.workers().length, ...selected });
      await page.waitForTimeout(1000);
    }
    measurements.push({ animate, nodeCount:2000, samples, errors });
    await page.close();
    await writeFile(destination, JSON.stringify({scope:'2000 source graph nodes, isolated headless Chromium; TaskDuration is renderer main-thread time, not OS CPU or worker CPU; 60-second samples after five-second warmup',browser:browser.version(),measurements},null,2)+'\n');
    console.log(JSON.stringify({animate, sampleCount:samples.length, workers:samples.at(-1).workers, taskDurationSeconds:samples.at(-1).TaskDuration-samples[0].TaskDuration, usedHeapStart:samples[0].JSHeapUsedSize, usedHeapEnd:samples.at(-1).JSHeapUsedSize, errors}));
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
