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
  engine: 'whisper.cpp' | null;
  /** M8-4: accelerator the resolved binary actually links. 'metal' build still
   *  falls back to CPU at runtime if Metal init fails — CPU is the guaranteed
   *  baseline (3s clip ≈ 70–300s on this 2-core-class Intel without Metal). */
  mode: 'metal' | 'cpu' | 'unknown';
}

function isExec(p: string): boolean {
  try { return path.isAbsolute(p) && statSync(p).isFile() && (accessSync(p, constants.X_OK) === undefined); } catch { return false; }
}

/** Link-level accelerator check: dylib-linked Metal builds reference
 *  libggml-metal (verified on this machine's builds). The managed
 *  ~/.jarvis/bin binary is the single install (PATH symlinks to it), so
 *  otool coverage is complete here; CPU-only builds report 'cpu'. */
function whisperMode(bin: string): VoicePreflight['mode'] {
  try {
    const out = execFileSync('otool', ['-L', bin], { encoding: 'utf8', timeout: 5000 });
    return /libggml-metal|Metal\.framework/.test(out) ? 'metal' : 'cpu';
  } catch { return 'unknown'; }
}

/** Single resolution point for the whisper binary (FR-6): prefers the local
 *  ~/.jarvis/bin build, else PATH. Everything that spawns whisper-cli must use
 *  this so readiness, mode reporting, and transcription run the SAME binary. */
export function resolveWhisperBin(): { path: string | null; source: VoicePreflight['source'] } {
  const preferred = path.join(os.homedir(), '.jarvis', 'bin', 'whisper-cli');
  if (isExec(preferred)) return { path: preferred, source: 'jarvis-bin' };
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && path.isAbsolute(dir) && isExec(path.join(dir, 'whisper-cli'))) return { path: path.join(dir, 'whisper-cli'), source: 'path' };
  }
  return { path: null, source: null };
}

/** FR-6: prefers the local ~/.jarvis/bin/whisper-cli build, else PATH. */
export function collectVoice(): VoicePreflight {
  const { path: resolved, source } = resolveWhisperBin();
  const model = existsModel() ? 'ready' : 'missing';
  return {
    whisper: resolved ? 'ready' : 'missing',
    path: resolved,
    source,
    model,
    engine: resolved ? 'whisper.cpp' : null,
    mode: resolved ? whisperMode(resolved) : 'unknown',
  };
}

function existsModel(): boolean {
  try { return statSync(path.join(os.homedir(), '.jarvis', 'models', 'ggml-small.bin')).isFile(); } catch { return false; }
}
