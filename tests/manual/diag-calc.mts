import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, channel: 'chrome' });
const p = await b.newPage();
await p.goto('file:///Users/nimon/Desktop/Jarvisexe/jarvis-orchestrator/projects/task-project-1790256265976/index.html');
await p.waitForTimeout(500);
console.log('buttons:', await p.locator('button').count());
console.log('all clickable-ish:', await p.locator('button, [onclick], [role="button"], .key, .btn').count());
const html = await p.content();
const buttons = [...html.matchAll(/<(button|div|span)[^>]*>[\s\S]{0,80}?/g)].slice(0, 0);
// just print a compact structural summary
const summary = await p.evaluate(() => {
  const out: string[] = [];
  const btns = document.querySelectorAll('button, [onclick], [role="button"]');
  btns.forEach((el, i) => { if (i < 20) out.push(`${el.tagName} "${(el.textContent ?? '').trim().slice(0, 12)}" ${el.className.slice(0, 40)}`); });
  const disp = document.querySelector('#display, .display, output');
  out.push('DISPLAY: ' + (disp ? `${disp.tagName} "${(disp.textContent ?? '').trim()}"` : 'NONE'));
  return out.join('\n');
});
console.log(summary);
await b.close();
process.exit(0);
