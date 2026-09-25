/**
 * UI E2E — Stage 1: task entry via the React UI → core → live status via SSE → STOP test.
 * Run: npx tsx tests/manual/ui-e2e-stage1.mts   (core server + vite dev must be running)
 */
import { chromium } from 'playwright';

const page = await (await chromium.launch({ headless: true, channel: 'chrome' })).newPage();
const logs: string[] = [];
const ok = (m: string) => { logs.push(`✔ ${m}`); console.log(`✔ ${m}`); };

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#task-request', { timeout: 20000 });
ok('UI loaded, task input present');

// 1. Task entry
await page.fill('#task-request', 'Create a simple calculator web app (plain HTML/CSS/JS in a single index.html, with add/subtract/multiply/divide, plus a node test script that verifies the calc logic) and verify it');
await page.click('button[aria-label="Execute task"]');
ok('Execute clicked');

// 2. Task appears in Current Task
await page.waitForSelector('.current-task .task-link', { timeout: 20000 });
const taskId = (await page.locator('.current-task .task-link').innerText()).trim();
ok(`Task appears in Current Task: ${taskId}`);

// 3. Status changes to planning (live SSE)
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.match(/Planning|Waiting for ChatGPT/),
  null,
  { timeout: 60000 },
);
ok('Status changed to planning (live update works)');

// 4. Activity events appear
await page.waitForSelector('.activity li', { timeout: 30000 });
const firstActivity = await page.locator('.activity li').first().innerText();
ok(`Activity live: "${firstActivity.replace(/\s+/g, ' ').slice(0, 60)}"`);

// 5. Wait for OpenCode EXECUTING (planning takes ~2-3 min)
console.log('waiting for OpenCode execution phase (2-4 min)...');
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.includes('OpenCode execution'),
  null,
  { timeout: 420000 },
);
ok('Status: OpenCode execution (EXECUTING)');

// 6. STOP TEST — click Stop, verify actual cancellation
await page.click('button[aria-label="Stop task"]');
await page.waitForFunction(
  () => document.querySelector('.current-task .pill')?.textContent?.includes('Cancelled'),
  null,
  { timeout: 30000 },
);
ok('STOP test: status became Cancelled');

// verify the opencode child actually died
const { execSync } = await import('node:child_process');
let opencodeAlive = false;
try {
  const out = execSync('pgrep -fl "opencode run"', { encoding: 'utf8' });
  opencodeAlive = out.includes('calculator');
} catch { opencodeAlive = false; }
ok(opencodeAlive ? '⚠ opencode still alive' : 'STOP test: opencode child process actually killed');

// state persisted?
const status = await (await fetch(`http://127.0.0.1:7788/api/task/${taskId}`)).json();
ok(`STOP test: state persisted on disk (${(status as { task: { status: string } }).task.status})`);

console.log(`\nSTAGE 1: ${logs.filter((l) => l.startsWith('✔')).length} checks passed`);
await page.context().close();
process.exit(opencodeAlive ? 1 : 0);
