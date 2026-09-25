/**
 * UI E2E — Stage 1b: RESTART test (reopen UI, persisted task visible) + STOP test.
 * Run: npx tsx tests/manual/ui-e2e-stage1b.mts   (core server + vite dev must be running)
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const page = await (await chromium.launch({ headless: true, channel: 'chrome' })).newPage();
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };

// RESTART TEST: fresh browser (no frontend memory) → reopen UI
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('.current-task .task-link', { timeout: 20000 });
const taskId = (await page.locator('.current-task .task-link').innerText()).trim();
console.log(`reopened UI: current task = ${taskId}`);

const pill = (await page.locator('.current-task .pill').innerText()).trim();
if (pill.includes('OpenCode execution') || pill.includes('Monitoring')) {
  ok(`RESTART test: persisted task state visible after reopen (${pill})`);
} else {
  fail(`RESTART test: unexpected state ${pill}`);
}

// task history intact?
const historyCount = await page.locator('.task-table tr').count();
void historyCount; // tasks page checked below
await page.click('.sidebar button:has-text("Tasks")');
await page.waitForSelector('.task-table tr', { timeout: 15000 });
const rows = await page.locator('.task-table tr').count();
if (rows >= 5) ok(`RESTART test: task history intact (${rows - 1} tasks)`);
else fail(`RESTART test: history too small (${rows - 1})`);

// STOP TEST: back to dashboard, click Stop on the running task
await page.click('.sidebar button:has-text("Dashboard")');
await page.waitForSelector('button[aria-label="Stop task"]', { timeout: 15000 });
const stopEnabled = await (await page.locator('button[aria-label="Stop task"]').first()).isEnabled();
if (!stopEnabled) { fail('STOP test: stop button disabled while task running'); }
await page.click('button[aria-label="Stop task"]');
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.includes('Cancelled'),
  null,
  { timeout: 30000 },
);
ok('STOP test: status became Cancelled');

// verify opencode child actually killed
let opencodeAlive = false;
try {
  const out = execSync('pgrep -fl "opencode run"', { encoding: 'utf8' });
  opencodeAlive = out.includes('calculator');
} catch { opencodeAlive = false; }
if (opencodeAlive) fail('STOP test: opencode still alive');
else ok('STOP test: opencode child process actually killed');

// state persisted on disk
const status = (await (await fetch(`http://127.0.0.1:7788/api/task/${taskId}`)).json()) as { task: { status: string } };
if (status.task.status === 'CANCELLED') ok('STOP test: state persisted on disk (CANCELLED)');
else fail(`STOP test: state on disk = ${status.task.status}`);

console.log(failures === 0 ? '\nSTAGE 1b: ALL PASS' : `\nSTAGE 1b: ${failures} FAILURES`);
await page.context().close();
process.exit(failures === 0 ? 0 : 1);
