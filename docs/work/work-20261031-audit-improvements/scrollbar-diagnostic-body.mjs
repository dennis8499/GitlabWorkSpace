await mkdir(output,{recursive:true});
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',ignoreDefaultArgs:['--hide-scrollbars']});
  const page=await browser.newPage({viewport:{width:800,height:600}});
  await page.setContent('<div id="test" style="width:300px;height:300px;overflow:auto;border:1px solid black"><div style="height:10000px">Scroll test</div></div>');
  const list=page.locator('#test'),box=await list.boundingBox();
  const track=await list.evaluate(e=>({width:e.offsetWidth-e.clientWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight}));
  const x=box.x+box.width-track.width/2,y=box.y+8;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x,box.y+box.height-8,{steps:10});await page.mouse.up();
  await page.waitForTimeout(150);
  const dragTop=await list.evaluate(e=>e.scrollTop);
  await list.hover();await page.mouse.wheel(0,100000);await page.waitForTimeout(150);
  const wheelTop=await list.evaluate(e=>e.scrollTop);
  const report={browser:browser.version(),box,track,dragTop,wheelTop,
    scope:'A standalone HTML overflow element in the same headless Chromium, not application code.'};
  await writeFile(path.join(output,'scrollbar.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser?.close();}
