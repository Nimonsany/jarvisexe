/**
 * FR-6/7 resource preflight: whisper/TTS-STT availability report + environment
 * resource-pressure classification. Thresholds are env-tunable
 * (JARVIS_PREFLIGHT_LOAD / _SWAP_PCT / _DISK_GB); a machine under pressure is
 * reported, never silently worked around.
 */
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

export interface Resources {
  load1m: number;
  load5m: number;
  memFreePct: number;
  swapUsedPct: number | null;
  diskFreeGb: number | null;
  status: 'ok' | 'resource-pressure';
  reasons: string[];
}

function readSwapUsedPct(): number | null {
  try {
    const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 3000 });
    const m = out.match(/\((\d+)%\)/);
    if (m) return Number(m[1]);
    const u = out.match(/used = ([\d.]+)([MG])/), t = out.match(/total = ([\d.]+)([MG])/);
    if (u && t) {
      const toMb = (v: string, unit: string) => Number(v) * (unit === 'G' ? 1024 : 1);
      return Math.round((toMb(u[1], u[2]) / toMb(t[1], t[2])) * 100);
    }
  } catch { /* ignore */ }
  return null;
}

export async function collectResources(): Promise<Resources> {
  const [load1m, load5m] = os.loadavg();
  const memFreePct = Math.round((os.freemem() / os.totalmem()) * 100);
  const swapUsedPct = readSwapUsedPct();
  let diskFreeGb: number | null = null;
  try {
    const fs = await statfs('/');
    diskFreeGb = Math.round((Number(fs.bavail) * Number(fs.bsize)) / 1e9);
  } catch { /* ignore */ }

  const thrLoad = Number(process.env.JARVIS_PREFLIGHT_LOAD || 64);
  const thrSwap = Number(process.env.JARVIS_PREFLIGHT_SWAP_PCT || 50);
  const thrDisk = Number(process.env.JARVIS_PREFLIGHT_DISK_GB || 5);
  const reasons: string[] = [];
  if (load1m > thrLoad) reasons.push(`load1m ${load1m.toFixed(0)} > ${thrLoad}`);
  if (swapUsedPct !== null && swapUsedPct > thrSwap) reasons.push(`swap used ${swapUsedPct}% > ${thrSwap}%`);
  if (diskFreeGb !== null && diskFreeGb < thrDisk) reasons.push(`disk free ${diskFreeGb}GB < ${thrDisk}GB`);

  return { load1m, load5m, memFreePct, swapUsedPct, diskFreeGb, status: reasons.length ? 'resource-pressure' : 'ok', reasons };
}

export interface VoicePreflight {
  whisper: 'ready' | 'missing';
  path: string | null;
  source: 'jarvis-bin' | 'path' | null;
  model: 'ready' | 'missing';
}

function isExec(p: string): boolean {
  try { return path.isAbsolute(p) && statSync(p).isFile() && (accessSync(p, constants.X_OK) === undefined); } catch { return false; }
}

/** FR-6: prefers the local ~/.jarvis/bin/whisper-cli build, else PATH. */
export function collectVoice(): VoicePreflight {
  const home = os.homedir();
  const preferred = path.join(home, '.jarvis', 'bin', 'whisper-cli');
  let resolved: string | null = null;
  let source: VoicePreflight['source'] = null;
  if (isExec(preferred)) { resolved = preferred; source = 'jarvis-bin'; }
  else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (dir && path.isAbsolute(dir) && isExec(path.join(dir, 'whisper-cli'))) { resolved = path.join(dir, 'whisper-cli'); source = 'path'; break; }
    }
  }
  const model = existsModel() ? 'ready' : 'missing';
  return { whisper: resolved ? 'ready' : 'missing', path: resolved, source, model };
}

function existsModel(): boolean {
  try { return statSync(path.join(os.homedir(), '.jarvis', 'models', 'ggml-small.bin')).isFile(); } catch { return false; }
}
