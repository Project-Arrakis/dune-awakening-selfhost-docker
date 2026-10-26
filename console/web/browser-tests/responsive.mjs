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
  await page.addInitScript(() => sessionStorage.setItem('dune-console:active-tab', 'Settings'));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'console.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      let body = { ok: true, stdout: '', items: [], keys: [], areas: [], addons: [], players: [], pending: [], byTarget: [] };
      if (url.pathname === '/api/auth/state') body = { authenticated: true, csrfToken: 'fixture', config: { version: '1.4.52' } };
      if (url.pathname === '/api/setup/state') body = { files: { complete: true }, config: {} };
      if (url.pathname === '/api/settings') body = { config: { port: 8088 }, files: {}, publicDirectory: { available: true, enabled: true }, serverStartup: { settings: { autoStartBattlegroup: true } } };
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
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    if (width <= 900 && await toggle.isVisible()) await toggle.click();
    const help = page.locator('.sidebar-nav').getByRole('link', { name: 'Get Help', exact: true });
    await help.scrollIntoViewIfNeeded();
    const bounds = await help.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, `last navigation link reachable at ${width}x${height}`);
    assert.equal(await help.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'link is not clipped by the navigation');
    const sidebar = await page.locator('.sidebar').boundingBox();
    assert.ok(sidebar.height <= height + 1, 'navigation fits inside the screen');
    if (width <= 900) await page.getByRole('button', { name: 'Close navigation' }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
  }
  assert.deepEqual(errors, []);
  console.log('PASS responsive Console navigation and expanded settings at eight viewport sizes');
} finally { await browser.close(); }
