// Run only the maintained packaged-UI smoke checks; no timing benchmark.
await mkdir(output,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'glw-fix-smoke-'));
let browser;
try{
  const files=await extractAssets(temp);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const report={artifactSha256:sha256(await readFile(artifactPath)),browser:browser.version(),...await smoke(browser,files)};
  await writeFile(path.join(output,'smoke.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,checks:report.checks},null,2));
  if(report.status!=='PASS')process.exitCode=1;
}finally{await browser?.close();assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(temp,{recursive:true,force:true});}
