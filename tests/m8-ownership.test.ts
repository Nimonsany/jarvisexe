/**
 * M8 BLOCKER 2 — exact process ownership.
 * Run: npx tsx --test tests/m8-ownership.test.ts
 *
 * - registry entries carry full ownership metadata (pid, pgid, exe, taskId, …)
 * - stopAll kills ONLY registered processes (and their group) — decoys survive
 * - boot recovery kills only identity-verified orphans; foreign pids untouched
 * - the bash verified-kill helper refuses unproven pids (the "owner's server
 *   on another port must survive" regression, exercised through the real helper)
 * - no pkill/killall/fuzzy-pgrep remains in lifecycle code or core kill paths
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ProcessRegistry } from '../packages/core/src/computer/registry.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('registry records full ownership metadata for a detached spawn', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-m8-meta-'));
  try {
    const reg = new ProcessRegistry(dir);
    const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    const entry = reg.register('sleep 300', p, { role: 'opencode', taskId: 'TASK-000001', detached: true });
    assert.ok(entry.pid, 'pid recorded');
    assert.equal(entry.pgid, entry.pid, 'detached spawn leads its own group');
    assert.equal(entry.role, 'opencode');
    assert.equal(entry.taskId, 'TASK-000001');
    assert.ok(entry.exe && entry.exe.includes('sleep'), 'exe identity recorded');
    assert.ok(entry.argsMarker && entry.argsMarker.includes('300'), 'argv marker recorded');
    assert.ok(entry.startedAt > 0, 'launch timestamp recorded');
    const listed = reg.list().find((l) => l.id === entry.id);
    assert.ok(listed, 'listed');
    assert.equal(listed!.pid, entry.pid);
    p.kill('SIGKILL');
    await sleep(200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stopAll kills registered processes AND their group; unrelated decoy survives', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-m8-stop-'));
  try {
    const reg = new ProcessRegistry(dir);
    // decoy: NOT registered — must survive stopAll
    const decoy = spawn('sleep', ['298'], { stdio: 'ignore' });
    assert.ok(decoy.pid);
    // registered detached parent that keeps a child in its own group
    const group = spawn('sh', ['-c', 'sleep 297 & wait'], { detached: true, stdio: 'ignore' });
    reg.register('sh -c group child', group, { role: 'opencode', taskId: 'TASK-000002', detached: true });
    await sleep(300);
    // find the group's child (sleep 297) via ppid walk
    const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' });
    const childSleep = ps.split('\n').find((l) => l.includes('sleep 297') && group.pid && l.includes(String(group.pid)));
    assert.ok(childSleep, 'group child exists before stop');

    const killed = reg.stopAll();
    assert.ok(killed >= 1, 'stopAll signalled the registered process');
    await sleep(600);
    assert.equal(alive(group.pid!), false, 'registered group leader dead');
    const childPid = Number(childSleep!.trim().split(/\s+/)[0]);
    assert.equal(alive(childPid), false, 'group child swept too (process-group kill)');
    assert.equal(alive(decoy.pid!), true, 'UNRELATED decoy survived stopAll');
    decoy.kill('SIGKILL');
    await sleep(150);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('boot recovery kills only identity-verified orphans from a previous run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-m8-rec-'));
  try {
    // previous run registered this orphan, then "crashed" (no stopAll)
    const prev = new ProcessRegistry(dir);
    const orphan = spawn('sleep', ['301'], { detached: true, stdio: 'ignore' });
    prev.register('sleep 301', orphan, { role: 'opencode', taskId: 'TASK-000003', detached: true });
    const foreign = spawn('sleep', ['302'], { stdio: 'ignore' }); // never registered
    await sleep(200);

    // new run: recoverStale from the persisted file
    const next = new ProcessRegistry(dir);
    const killed = next.recoverStale();
    await sleep(300);
    assert.equal(killed, 1, 'exactly one verified orphan killed');
    assert.equal(alive(orphan.pid!), false, 'previous run\'s orphan terminated');
    assert.equal(alive(foreign.pid!), true, 'foreign (unregistered) process untouched');
    assert.equal(readFileSync(path.join(dir, 'owned-processes.json'), 'utf8').trim(), '[]', 'file cleared');
    foreign.kill('SIGKILL');
    try { orphan.kill('SIGKILL'); } catch { /* already dead */ }
    await sleep(150);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PID reuse guard: recovery never signals a foreign pid (wrong argv marker)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-m8-pid-'));
  try {
    const foreign = spawn('sleep', ['303'], { stdio: 'ignore' });
    await sleep(200);
    assert.ok(foreign.pid);
    // persisted entry from "another install" pointing at the foreign pid
    writeFileSync(path.join(dir, 'owned-processes.json'), JSON.stringify([{
      id: 'stale', pid: foreign.pid, pgid: null, exe: '/bin/sleep',
      argsMarker: 'some-other-install/jarvis-core server.js',
      taskId: null, role: 'opencode', command: 'stale', startedAt: Date.now(), detached: false,
    }]));
    const reg = new ProcessRegistry(dir);
    const killed = reg.recoverStale();
    await sleep(200);
    assert.equal(killed, 0, 'nothing killed — identity did not match');
    assert.equal(alive(foreign.pid), true, 'foreign pid still alive');
    foreign.kill('SIGKILL');
    await sleep(150);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verified-kill.sh: refuses an unproven pid (owner\'s server survives), kills proven one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-m8-bash-'));
  const helper = path.join(repoRoot, 'scripts/release/verified-kill.sh');
  // "owner's server": an unrelated listener on its own port
  const decoyProc = spawn(process.execPath, ['-e', 'require("http").createServer((_q,s)=>s.end("ok")).listen(0, "127.0.0.1", ()=>console.log("ready"))'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const decoyPid = decoyProc.pid!;
  // "our install": a process whose argv carries the unique install path
  const ownedScript = path.join(dir, 'JARVIS.app', 'Contents', 'MacOS', 'owned-proc.sh');
  execFileSync('mkdir', ['-p', path.dirname(ownedScript)]);
  writeFileSync(ownedScript, '#!/bin/sh\nsleep 304\n');
  const ownedProc = spawn('sh', [ownedScript], { stdio: 'ignore' });
  const ownedPid = ownedProc.pid!;
  await sleep(400);

  const run = (pid: number, ident: string, sig = 'TERM'): number => {
    try {
      execFileSync('bash', ['-c', `. "${helper}"; verified_kill_pid "$1" "$2" "${sig}"`, '_', String(pid), ident], { stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? 1;
    }
  };

  // wrong identity → refused (exit 1) AND still alive
  const refused = run(decoyPid, '/some/other/JARVIS.app');
  assert.equal(refused, 1, 'identity mismatch refuses (non-zero)');
  assert.equal(alive(decoyPid), true, 'owner\'s server survived the refused kill');
  // right identity → signalled
  const proven = run(ownedPid, ownedScript);
  assert.equal(proven, 0, 'proven ownership signals');
  await sleep(400);
  assert.equal(alive(ownedPid), false, 'proven process terminated');

  decoyProc.kill('SIGKILL');
  ownedProc.kill('SIGKILL');
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
});

test('BLOCKER 2 regression: no pkill/killall/fuzzy kill patterns in lifecycle or core kill code', () => {
  const offenders: string[] = [];
  const scan = (dir: string, ext: RegExp, forbid: RegExp[]) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { scan(p, ext, forbid); continue; }
      if (!ext.test(name)) continue;
      const text = readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        for (const f of forbid) if (f.test(line)) offenders.push(`${path.relative(repoRoot, p)}: ${line.trim().slice(0, 120)}`);
      }
    }
  };
  // lifecycle scripts: no broad pkill/killall at all
  scan(path.join(repoRoot, 'scripts'), /\.(sh|bash)$/, [/\bpkill\b/, /\bkillall\b/]);
  // core: the old fuzzy pgrep kill pattern must be gone
  scan(path.join(repoRoot, 'packages/core/src'), /\.ts$/, [
    /pgrep[^\n]*opencode\|Chromium/,
    /pgrep[^\n]*headless_shell/,
    /pkill/,
    /killall/,
  ]);
  assert.deepEqual(offenders, [], `forbidden kill patterns found:\n${offenders.join('\n')}`);
});
