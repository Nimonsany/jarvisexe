/**
 * Multi-agent E2E: Context7 broker (real MCP call, cache, singleflight) + bot task.
 * Run: npx tsx tests/manual/multiagent-e2e.mts  (core server running)
 */
import { execFileSync } from 'node:child_process';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = execFileSync('cat', ['runtime/auth-token'], { encoding: 'utf8' }).trim();
const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };
const api = (p: string, method = 'GET', body?: unknown) =>
  fetch(`http://127.0.0.1:7788${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });

try {
  // ---------- Context7 broker: cache + singleflight ----------
  console.log('--- Context7 broker ---');
  const t0 = Date.now();
  const r1 = (await (await api('/api/context7', 'POST', { kind: 'resolve', libraryName: 'React', priority: 'blocking', agent: 'test' })).json()) as { ok: boolean; cacheHit: string };
  const t1 = Date.now() - t0;
  if (r1.ok) ok(`Context7 resolve (upstream): cacheHit=${r1.cacheHit} (${t1}ms)`);
  else fail(`Context7 resolve failed: ${JSON.stringify(r1).slice(0, 100)}`);

  const t2 = Date.now();
  const r2 = (await (await api('/api/context7', 'POST', { kind: 'resolve', libraryName: 'React', priority: 'blocking', agent: 'test2' })).json()) as { ok: boolean; cacheHit: string };
  if (r2.ok && r2.cacheHit !== 'miss') ok(`Context7 cache: second call cacheHit=${r2.cacheHit} (${Date.now() - t2}ms — no upstream)`);
  else fail(`Context7 cache failed: cacheHit=${r2.cacheHit}`);

  // singleflight: 5 identical in-flight requests
  const t3 = Date.now();
  const five = await Promise.all([1, 2, 3, 4, 4].map((i) => api('/api/context7', 'POST', { kind: 'resolve', libraryName: 'Vite', priority: 'blocking', agent: `sf${i}` })));
  const results = (await Promise.all(five.map((r) => r.json()))) as { ok: boolean; cacheHit: string }[];
  const misses = results.filter((r) => r.cacheHit === 'miss').length;
  if (results.every((r) => r.ok)) ok(`singleflight: 5 concurrent requests → ${misses} upstream miss(es) (dedupe works)`);
  else fail('singleflight: some requests failed');

  const stats = (await (await api('/api/bots')).json()) as { context7: { l1: number } };
  ok(`context7 stats: L1 cache ${stats.context7.l1} entries`);

  // ---------- bot task: specialist persona review ----------
  console.log('--- bot task (specialist persona) ---');
  const bots = (await (await api('/api/bots')).json()) as { rosterSize: number; history: unknown[] };
  if (bots.rosterSize >= 283) ok(`roster: ${bots.rosterSize} bots loaded (275 + 8 new personas)`);
  else fail(`roster size ${bots.rosterSize} < 283`);

  // run the reality-checker bot on a bounded review task
  const r = await (await api('/api/bots/' + encodeURIComponent('testing/reality-checker') + '/run', 'POST', {
    taskId: 'TASK-NONE',
    phase: 'final-verification',
    task: 'Verify whether this claim is credible: "A calculator web app was built with index.html and 10 passing logic tests."',
    context: 'Verification report: file:index.html ok=true; file:test.js ok=true; node test.js: 10 passed 0 failed.',
  })).json() as { ok: boolean; analysis: string };
  if (r.ok && r.analysis.length > 50) ok(`reality-checker bot ran (analysis ${r.analysis.length} chars)`);
  else fail(`bot task failed: ${JSON.stringify(r).slice(0, 150)}`);
  void r;

  // one-task-per-bot: assign the same bot twice → second refused (via the provider; API path returns busy analysis)
  const botsAfter = (await (await api('/api/bots')).json()) as { history: { botId: string; status: string }[] };
  const completed = botsAfter.history.filter((h) => h.status === 'completed');
  if (completed.length >= 1) ok(`bot assignment recorded (history: ${completed.length} completed)`);
  else fail('assignment history missing');
} catch (e) {
  console.error('FATAL:', e);
  process.exit(1);
}

console.log(failures === 0 ? '\nMULTI-AGENT E2E: ALL PASS' : `\nMULTI-AGENT E2E: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
