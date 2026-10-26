// Run after npm run build. PLAYWRIGHT_MODULE may point to a Playwright install.
// Every request is intercepted: this test never connects to a real Console.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const sizes = [[320, 740], [390, 844], [768, 1024], [844, 390], [1024, 600], [1280, 720], [1920, 1080], [2560, 1440]];
try {
  const page = await browser.newPage({ hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
  await page.addInitScript(() => { if(!sessionStorage.getItem('dune-console:active-tab')) sessionStorage.setItem('dune-console:active-tab', 'Settings'); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'console.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      let body = { ok: true, stdout: '', items: [], keys: [], areas: [], addons: [], players: [], pending: [], byTarget: [] };
      if (url.pathname === '/api/auth/state') body = { authenticated: true, csrfToken: 'fixture', config: { version: '1.4.52' } };
      if (url.pathname === '/api/setup/state') body = { files: { complete: true }, config: {} };
      if (url.pathname === '/api/settings') body = { config: { port: 8088 }, files: {}, publicDirectory: { available: true, enabled: true }, serverStartup: { settings: { autoStartBattlegroup: true } } };
      if (url.pathname === '/api/settings/api-keys/catalog') body = {namespaces:[{namespace:'players',readActions:['list','profile'],writeActions:['giveItems'],supportsWrite:true}]};
      if (url.pathname === '/api/players/list-settings') body = { settings: { inactiveWeeks: null }, limits: { inactiveWeeks: { min: 1, max: 8 } }, canConfigure: true };
      if (url.pathname === '/api/logs/services') body = { services: ['director', 'survival-1', 'autoscaler'] };
      if (url.pathname === '/api/server/restart-queue') body = {state:{entries:[]},settings:{defaultCountdownMinutes:30,broadcastCheckpoints:[15,10,5,1],messages:{}},defaults:{messages:{}},playersOnline:0};
      if (url.pathname === '/api/admin/message-of-the-day') body = {settings:{enabled:false,title:'',message:'',deliveryMode:'login'},defaults:{},status:{}};
      if (url.pathname === '/api/admin/player-announcements') body = {settings:{joinEnabled:false,leaveEnabled:false,joinMessage:'',leaveMessage:''},defaults:{}};
      if (url.pathname === '/api/bases') body = { rows: [{base_id:'6001',name:'Desert Retreat',owner_name:'Desert Explorer',base_type:'Sub-Fief',shared_with:[],piece_count:100,placeable_count:12,generators:[]}], totalCount:1, totalBases:1, capabilities:{bases:true} };
      if (url.pathname.includes('/updates/check-')) body = { task: { id: 'fixture', status: 'succeeded', logLines: [], warnings: [] } };
      return route.fulfill({ json: body });
    }
    const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
    return route.fulfill({ contentType, body: readFileSync(file) });
  });
  await page.goto('http://console.test/');
  await page.getByRole('button', { name: 'Expand Server Startup' }).waitFor();
  const sections = await page.getByRole('button', { name: /^Expand / }).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  for (const name of sections) await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button',{name:'Create Key',exact:true}).waitFor();
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    if (width <= 900 && await toggle.isVisible()) await toggle.click();
    for (const selector of ['.sidebar', '.sidebar-nav']) {
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).overflowY), 'visible', `${selector} must not have its own scrolling area`);
    }
    const help = page.locator('.sidebar-nav').getByRole('link', { name: 'Get Help', exact: true });
    await help.scrollIntoViewIfNeeded();
    const bounds = await help.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, `last navigation link reachable at ${width}x${height}`);
    assert.equal(await help.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'link is not clipped by the navigation');
    assert.equal(await page.locator('.sidebar-nav').evaluate(el => el.scrollTop), 0, 'navigation uses page scrolling');
    if (width <= 900) {
      await page.getByRole('button', { name: 'Close navigation' }).click();
      assert.equal(await page.locator('.sidebar-nav').isVisible(), false);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
  }
  for (const tab of ['Players', 'Bases', 'Backups', 'Server Control', 'Logs', 'Admin Tools']) {
    await page.evaluate(tab => sessionStorage.setItem('dune-console:active-tab', tab), tab);
    await page.reload();
    await page.locator('main h2').first().waitFor();
    if(tab==='Admin Tools') await page.getByRole('button',{name:'Expand Schedule Server Restart',exact:true}).click();
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height});
      assert.equal(await page.getByText('Could not load this section.', {exact:true}).count(),0,`${tab} rendered`);
      if (width<=560 && ['Players','Bases'].includes(tab)) {
        const pagination=page.locator('.database-pagination-controls').first();
        assert.ok((await pagination.boundingBox()).height<110,'phone pagination uses two compact rows');
        const buttons=await pagination.locator('button').all();
        const boxes=await Promise.all(buttons.map(button=>button.boundingBox()));
        assert.ok(Math.max(...boxes.map(r=>r.y))-Math.min(...boxes.map(r=>r.y))<2,'paging buttons remain on the same row');
        const search=page.locator(tab==='Players'?'.players-search-row':'.bases-search-row');
        assert.ok((await search.locator('input').boundingBox()).width>width*.7,'phone search field has readable width');
        for(const button of await search.locator('button').all())assert.ok((await button.boundingBox()).width>=100,'search actions retain readable captions');
      }
      if(tab==='Bases' && width<=1800){
        const head=await page.locator('.bases-table thead').boundingBox(),row=await page.locator('.bases-table tbody tr').first().boundingBox();
        assert.ok(row.y>=head.y+head.height-1,'mobile table header never covers the first base');
        assert.ok((await page.locator('.bases-table tbody tr').first().locator('td').nth(4).boundingBox()).width>=90,'base owner names have readable column width');
        for(const cell of await page.locator('.bases-table thead th').all()) assert.ok(await cell.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'base column headings never overlap');
      }
      if(tab==='Backups'){
        for(const field of await page.locator('.backup-number-unit').all()){
          const input=await field.locator('input').boundingBox(),unit=await field.locator('span').boundingBox();
          assert.ok(input.width>=90,'backup value remains readable');
          assert.ok(unit.x>=input.x+input.width && Math.abs(unit.y+unit.height/2-input.y-input.height/2)<2,'unit stays beside its value');
        }
      }
      if(tab==='Logs'){
        const select=await page.getByRole('combobox').first().boundingBox();
        const refresh=await page.getByRole('button',{name:'Refresh Logs',exact:true}).boundingBox();
        assert.ok(Math.abs(select.height-refresh.height)<=2,'dropdown and adjacent refresh action have matching heights');
      }
      if(tab==='Admin Tools'){
        for(const field of await page.locator('.schedule-action-line label.compact-select').all()){
          const label=await field.boundingBox(),input=await field.locator('input').boundingBox();
          assert.ok(input.x+input.width<=label.x+label.width+1,'schedule input stays inside its field and clear of adjacent actions');
        }
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${tab} fits ${width}px`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS navigation, pagination, search, table headers, backup units and matching control heights at eight viewport sizes');
} finally { await browser.close(); }
