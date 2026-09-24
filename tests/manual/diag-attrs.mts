import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('runtime/browser-profile', { headless: false, channel: 'chrome' });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
const box = page.locator('div[contenteditable="true"]').first();
await box.click();
await box.evaluate((el, t) => {
  (el as HTMLElement).focus();
  el.textContent = t;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: t }));
}, 'Reply with exactly: JARVIS_DIAG2_OK');
await page.keyboard.press('Enter');
await page.waitForTimeout(20000);
const info = await page.evaluate(() => {
  const el = [...document.querySelectorAll('div')].find((n) => n.textContent?.trim().startsWith('JARVIS_DIAG2_OK'));
  if (!el) return 'not found in divs';
  const chain: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; i < 8 && cur; i++) {
    chain.push(`${cur.tagName} ${[...cur.attributes].map((a) => `${a.name}="${String(a.value).slice(0, 80)}"`).join(' ').slice(0, 220)}`);
    cur = cur.parentElement;
  }
  return chain.join('\n---\n');
});
console.log(info);
await ctx.close();
process.exit(0);
