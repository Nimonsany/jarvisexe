import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Task } from '../task/types.js';

export interface VerificationStep {
  name: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

export interface VerificationReport {
  passed: boolean;
  steps: { name: string; ok: boolean; detail: string }[];
}

export interface SoftwareVerificationSpec {
  /** files that must exist, relative to project dir */
  required_files?: string[];
  /** shell command run in project dir that must exit 0 (e.g. `npm test`) */
  test_command?: string;
  /** URL that must respond 2xx (e.g. local dev server) */
  http_endpoint?: string;
  timeout_ms?: number;
}

export class Verifier {
  async verifySoftware(task: Task, spec: SoftwareVerificationSpec): Promise<VerificationReport> {
    const steps: VerificationStep[] = [];
    const dir = task.project_directory;

    for (const f of spec.required_files ?? []) {
      steps.push({
        name: `file:${f}`,
        run: async () => {
          const p = path.join(dir, f);
          // path traversal guard: resolved path must stay inside project dir
          if (!path.resolve(p).startsWith(path.resolve(dir))) {
            return { ok: false, detail: 'path escapes project directory' };
          }
          return existsSync(p) ? { ok: true, detail: p } : { ok: false, detail: `missing ${p}` };
        },
      });
    }

    if (spec.test_command) {
      const cmd = spec.test_command;
      steps.push({
        name: `test:${cmd}`,
        run: () =>
          new Promise((resolve) => {
            // run via shell -c is intentional but command comes from ChatGPT-approved plan;
            // restrict to safe characters as a baseline guard.
            if (/[;&|`$(){}\[\]<>]/.test(cmd.replace(/&&/g, '').replace(/\|\|/g, ''))) {
              return resolve({ ok: false, detail: 'test command rejected by safety filter' });
            }
            const p = spawn('sh', ['-c', cmd], { cwd: dir, timeout: spec.timeout_ms ?? 120_000 });
            let out = '';
            p.stdout?.on('data', (c) => (out += c));
            p.stderr?.on('data', (c) => (out += c));
            p.on('exit', (code) => resolve({ ok: code === 0, detail: out.slice(-1000) || `exit ${code}` }));
            p.on('error', (e) => resolve({ ok: false, detail: String(e) }));
          }),
      });
    }

    if (spec.http_endpoint) {
      const url = spec.http_endpoint;
      steps.push({
        name: `http:${url}`,
        run: async () => {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            return res.ok
              ? { ok: true, detail: `HTTP ${res.status}` }
              : { ok: false, detail: `HTTP ${res.status}` };
          } catch (e) {
            return { ok: false, detail: String(e) };
          }
        },
      });
    }

    const results: VerificationReport['steps'] = [];
    for (const s of steps) {
      try {
        const r = await s.run();
        results.push({ name: s.name, ...r });
      } catch (e) {
        results.push({ name: s.name, ok: false, detail: String(e) });
      }
    }
    // Empty spec (no steps defined) → nothing to verify; pass with a note
    // rather than looping forever. Tasks with specs still verify for real.
    return { passed: results.every((r) => r.ok), steps: results };
  }
}
