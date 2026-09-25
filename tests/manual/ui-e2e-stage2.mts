/**
 * UI E2E — Stage 2: RESTART test (history intact) + STOP test on a live task.
 * Run: npx tsx tests/manual/ui-e2e-stage2.mts   (core server + vite dev must be running)
 */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const page = await (await chromium.launch({ headless: true, channel: 'chrome' })).newPage();
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };

// RESTART TEST: fresh browser → reopen UI → history visible
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('.sidebar', { timeout: 20000 });
await page.click('.sidebar button:has-text("Tasks")');
await page.waitForSelector('.task-table tbody tr', { timeout: 20000 });
const rows = (await page.locator('.task-table tbody tr').count()) - 1;
if (rows >= 5) ok(`RESTART test: task history intact after reopen (${rows} tasks)`);
else fail(`RESTART test: history too small (${rows})`);

// completed task visible with status
const completedRow = page.locator('.task-table tr', { hasText: 'TASK-000007' });
if (await completedRow.count()) {
  const st = await completedRow.locator('.pill').innerText();
  if (st.includes('Completed')) ok('RESTART test: completed task shows Completed status');
  else fail(`completed task shows ${st}`);
} else fail('TASK-000007 not in history');

// STOP TEST: create a quick task via the UI
await page.click('.sidebar button:has-text("Dashboard")');
await page.waitForSelector('#task-request', { timeout: 15000 });
await page.fill('#task-request', 'Create a tiny text file named hello.txt containing exactly JARVIS_STOP_TEST and a node script check.js that verifies it, in the project directory');
await page.click('button[aria-label="Execute task"]');
await page.waitForSelector('.current-task .task-link', { timeout: 20000 });
const taskId = (await page.locator('.current-task .task-link').innerText()).trim();
ok(`stop-test task created via UI: ${taskId}`);

// wait for OpenCode execution
console.log('waiting for OpenCode execution phase...');
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.includes('OpenCode execution'),
  null,
  { timeout: 420000 },
);
ok('task reached EXECUTING');
await page.waitForTimeout(5000); // let opencode actually start working

// STOP
await page.click('button[aria-label="Stop task"]');
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.includes('Cancelled'),
  null,
  { timeout: 30000 },
);
ok('STOP test: status became Cancelled');

// opencode actually killed?
let opencodeAlive = false;
try {
  const out = execSync('pgrep -fl "opencode run"', { encoding: 'utf8' });
  opencodeAlive = /opencode.*run/.test(out) && !out.includes('grep');
} catch { opencodeAlive = false; }
if (opencodeAlive) fail('STOP test: opencode process still alive');
else ok('STOP test: opencode child process actually killed');

// state persisted
const status = (await (await fetch(`http://127.0.0.1:7788/api/task/${taskId}`)).json()) as { task: { status: string } };
if (status.task.status === 'CANCELLED') ok('STOP test: state persisted on disk (CANCELLED)');
else fail(`STOP test: state on disk = ${status.task.status}`);

// UI still responsive (navigate works)
await page.click('.sidebar button:has-text("Logs")');
await page.waitForSelector('.logview, .filters', { timeout: 10000 });
ok('STOP test: UI remains responsive after stop');

console.log(failures === 0 ? '\nSTAGE 2: ALL PASS' : `\nSTAGE 2: ${failures} FAILURES`);
await page.context().close();
process.exit(failures === 0 ? 0 : 1);
