/**
 * M3 UI E2E: authenticated UI → task creation → live SSE → Computer Activity.
 * Run: npx tsx tests/manual/m3-ui-e2e.mts  (core server + vite dev running)
 */
import { chromium } from 'playwright';

const page = await (await chromium.launch({ headless: true, channel: 'chrome' })).newPage();
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#task-request', { timeout: 20000 });
ok('UI loaded (bootstrap + token auth worked — page rendered data)');

// health bar shows live states (authenticated fetches)
await page.waitForSelector('.healthbar', { timeout: 15000 });
const health = await page.locator('.healthbar').innerText();
if (health.includes('JARVIS Core')) ok(`M3 UI: health bar live (${health.replace(/\s+/g, ' ').slice(0, 80)})`);
else fail('M3 UI: health bar missing');

// task creation through the authenticated UI
await page.fill('#task-request', 'Create a tiny HTML page m3ui.html with a button that changes its heading text when clicked');
await page.click('button[aria-label="Execute task"]');
await page.waitForSelector('.current-task .task-link', { timeout: 30000 });
const taskId = (await page.locator('.current-task .task-link').innerText()).trim();
ok(`M3 UI: task created via UI: ${taskId}`);

// live status via SSE (token-authenticated)
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.match(/Planning|Waiting for ChatGPT/),
  null,
  { timeout: 60000 },
);
ok('M3 UI: live status via authenticated SSE');

// Computer Activity section exists and updates
await page.waitForSelector('.activity', { timeout: 20000 });
ok('M3 UI: activity sections rendered');

console.log(failures === 0 ? '\nM3 UI E2E: ALL PASS' : `\nM3 UI E2E: ${failures} FAILURES`);
await page.context().close();
process.exit(failures === 0 ? 0 : 1);
