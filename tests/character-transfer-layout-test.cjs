// Run with Node and Playwright available (via node_modules or NODE_PATH).
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const css = readFileSync(resolve(__dirname, '../console/web/src/styles.css'), 'utf8');
    await page.setContent(`<style>${css}</style><div style="padding:24px"><div class="character-transfer-grid">
      <label class="character-transfer-row character-transfer-boolean-row"><span>Accept outgoing character transfers</span><strong>True</strong><input type="checkbox" checked></label>
      <label class="character-transfer-row character-transfer-boolean-row"><span>Validate character before import</span><strong>False</strong><input type="checkbox"></label>
    </div></div>`);
    for (const width of [1440, 1200, 1024, 768, 560, 390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      const rows = await page.locator('.character-transfer-boolean-row').evaluateAll(elements => elements.map(row => {
        const rect = row.getBoundingClientRect();
        const checkbox = row.querySelector('input').getBoundingClientRect();
        return {
          rightInset: rect.right - checkbox.right,
          topInset: checkbox.top - rect.top,
          bottomInset: rect.bottom - checkbox.bottom,
          overflows: row.scrollWidth > row.clientWidth,
          checkboxWidth: checkbox.width,
        };
      }));
      for (const row of rows) {
        assert.equal(row.overflows, false, `Row overflows at ${width}px`);
        assert.ok(row.rightInset >= 16, `Checkbox lacks right spacing at ${width}px: ${row.rightInset}`);
        assert.ok(row.topInset >= 8 && row.bottomInset >= 8, `Checkbox lacks vertical spacing at ${width}px`);
        assert.equal(row.checkboxWidth, 20);
      }
      await page.locator('label').nth(1).click();
      assert.equal(await page.locator('input').nth(1).isChecked(), true);
      await page.locator('label').nth(1).click();
      assert.equal(await page.locator('input').nth(1).isChecked(), false);
    }
    console.log('PASS: Character transfer checkbox spacing, overflow and label interaction at seven viewport widths.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
