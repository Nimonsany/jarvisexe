/**
 * Gate C: health responsiveness while the ChatGPT browser is launching.
 * Run: npx tsx tests/manual/gate-c-health.mts  (core server must be running)
 */
import { execFileSync } from 'node:child_process';

const token = execFileSync('cat', ['runtime/auth-token'], { encoding: 'utf8' }).trim();
const H = { 'Authorization': `Bearer ${token}` };

// trigger ChatGPT login (browser launch — the expensive path)
const login = await fetch('http://127.0.0.1:7788/api/chatgpt/login', { method: 'POST', headers: H });
console.log('login trigger:', login.status);

// hammer /health while the browser launches
const latencies: number[] = [];
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:7788/api/health', { headers: H });
  await r.json();
  latencies.push(Date.now() - t0);
  await new Promise((res) => setTimeout(res, 250));
}
const max = Math.max(...latencies);
const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
console.log(`health latencies while browser launching: avg=${avg}ms max=${max}ms`);
console.log(max < 500 ? 'GATE C: PASS (health stays responsive)' : `GATE C: FAIL (max ${max}ms >= 500ms)`);

// leave the login watcher running is fine; it closes itself after login detected
process.exit(max < 500 ? 0 : 1);
