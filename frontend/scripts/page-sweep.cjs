// scripts/page-sweep.cjs
//
// Browser pass for the thesis (Section 5.1.3): signs in with each quick-access
// demo account on the login page, opens every page in that role's navigation
// and reports page errors, console errors and API responses >= 500.
//
// Run from frontend/ against a running app (backend + Vite):
//   node scripts/page-sweep.cjs [http://127.0.0.1:5173] [screenshot-dir]
// Raise the backend's RATE_LIMIT_PER_MINUTE / AUTH_RATE_LIMIT_PER_MINUTE for
// the run: the sweep signs in and reloads pages faster than a person does.
const { chromium } = require(process.cwd() + '/node_modules/playwright');
const S = process.argv[3] || require('node:os').tmpdir();
const URL = process.argv[2] || 'http://127.0.0.1:5173';
(async () => {
  const b = await chromium.launch();
  const probe = await (await b.newContext()).newPage();
  await probe.goto(URL);
  const labels = await probe.locator('.login-quick-btn').allTextContents();
  let problems = 0;
  for (const label of labels) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_ABORTED|EventSource/.test(m.text())) errs.push('console: ' + m.text()); });
    p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url().replace(URL, '')}`); });
    await p.goto(URL);
    await p.locator('.login-quick-btn', { hasText: label }).first().click();
    await p.waitForTimeout(1500);
    const links = await p.locator('nav a[href]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
    const visited = [];
    for (const href of links) {
      await p.goto(URL + href);
      await p.waitForLoadState('domcontentloaded');
      await p.waitForTimeout(1500);
      const body = await p.locator('body').innerText();
      if (/something went wrong|failed to fetch|TypeError|undefined is not/i.test(body)) errs.push(`error text on ${href}`);
      visited.push(href);
    }
    const shot = `${S}/ui-${label.replace(/\W+/g, '_')}.png`;
    await p.screenshot({ path: shot });
    console.log(`${errs.length ? 'FAIL' : 'ok  '} ${label}: ${visited.length} pages`);
    for (const e of [...new Set(errs)]) console.log('      ' + e.slice(0, 300));
    problems += errs.length;
    await ctx.close();
  }
  console.log(problems ? `${problems} problem(s)` : 'no UI errors');
  await b.close();
  process.exit(problems ? 1 : 0);
})();
