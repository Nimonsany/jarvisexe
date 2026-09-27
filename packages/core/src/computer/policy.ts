import path from 'node:path';
import os from 'node:os';
import type { ComputerActionInput, PermissionCategory } from './types.js';
import type { TaskStore } from '../task/store.js';

export interface PolicyDecision {
  allowed: boolean;
  category: PermissionCategory;
  reason: string;
  requiresApproval: boolean;
}

const RISK: Record<string, PermissionCategory> = {
  // filesystem
  exists: 'READ', read: 'READ', list: 'READ', stat: 'READ', hash: 'READ',
  write: 'SAFE_WRITE', append: 'SAFE_WRITE', mkdir: 'SAFE_WRITE',
  copy: 'SAFE_WRITE', rename: 'SAFE_WRITE',
  'delete-to-trash': 'SAFE_WRITE',
  'delete-permanent': 'DESTRUCTIVE',
  // terminal
  run: 'EXECUTE',
  // applications
  detect: 'READ', 'running-state': 'READ',
  launch: 'EXECUTE', open: 'EXECUTE', 'open-url': 'EXECUTE', activate: 'EXECUTE', close: 'EXECUTE',
  // clipboard
  'clipboard-read': 'READ', 'clipboard-write': 'SAFE_WRITE', 'clipboard-clear': 'SAFE_WRITE',
  // screen
  capture: 'READ',
  // keyboard/mouse
  type: 'UI_AUTOMATION', press: 'UI_AUTOMATION', combo: 'UI_AUTOMATION',
  move: 'UI_AUTOMATION', click: 'UI_AUTOMATION', 'double-click': 'UI_AUTOMATION',
  'right-click': 'UI_AUTOMATION', scroll: 'UI_AUTOMATION', drag: 'UI_AUTOMATION',
};

// filesystem 'move' is SAFE_WRITE (mouse 'move' is UI_AUTOMATION); resolved by capability in authorize


/** Locations JARVIS never touches automatically (secret protection). */
const SECRET_PATH_PARTS = ['/.ssh/', '/.gnupg/', '/.env', '/keychain', '/cookies', '/browser-profile/', '/Library/Keychains/', 'id_rsa', 'id_ed25519', '/.aws/', '/.kube/'];
export const DESTRUCTIVE_PATTERNS = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b|\bmkfs\b|\bdd\s+if=\/dev\/(zero|random)\s+of=\/dev\//;

export function canonicalize(p: string): string {
  if (p.includes('\0')) throw new Error('null byte in path');
  return path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
}

export function isSecretLocation(canonicalPath: string): boolean {
  return SECRET_PATH_PARTS.some((part) => canonicalPath.includes(part));
}

export class SecurityPolicy {
  constructor(private store: TaskStore) {}

  /** Every computer action passes through here BEFORE execution. */
  async authorize(action: ComputerActionInput, taskId: string | null, taskProjectDir: string | null): Promise<PolicyDecision> {
    let category = RISK[action.operation] ?? 'READ';
    if (action.operation === 'move' && action.capability === 'filesystem') category = 'SAFE_WRITE';
    if (action.operation === 'move' && action.capability === 'mouse') category = 'UI_AUTOMATION';

    // STOP/PAUSE integration: no new actions for paused/cancelled tasks
    if (taskId) {
      try {
        const task = await this.store.load(taskId);
        if (task.status === 'CANCELLED') return { allowed: false, category, reason: 'task is CANCELLED — no new actions', requiresApproval: false };
        if (task.status === 'PAUSED') return { allowed: false, category, reason: 'task is PAUSED — resume before new actions', requiresApproval: false };
        taskProjectDir = taskProjectDir ?? task.project_directory;
      } catch { /* unknown task — treat as owner-direct */ }
    }

    // path-bearing operations: canonicalize + secret protection + scope
    const pathArg = (action.args?.path ?? action.args?.source ?? action.args?.destination ?? action.args?.cwd) as string | undefined;
    let canonical: string | null = null;
    if (typeof pathArg === 'string') {
      try { canonical = canonicalize(pathArg); } catch (e) { return { allowed: false, category, reason: String(e), requiresApproval: false }; }

      if (isSecretLocation(canonical) && !action.justified) {
        return { allowed: false, category, reason: `secret location refused: ${canonical} — set justified:true with explicit task justification if truly required`, requiresApproval: false };
      }

      // writes outside project scope require explicit justification
      const isWrite = category === 'SAFE_WRITE' || category === 'DESTRUCTIVE';
      if (isWrite && taskProjectDir && !canonical.startsWith(path.resolve(taskProjectDir)) && !action.justified) {
        return { allowed: false, category, reason: `outside project scope (${taskProjectDir}) — set justified:true with explicit justification`, requiresApproval: false };
      }
    }

    // terminal command safety
    if (action.operation === 'run') {
      const cmd = String(action.args?.command ?? '');
      if (/^\s*sudo\b/.test(cmd)) return { allowed: false, category, reason: 'sudo is never automatic', requiresApproval: false };
      if (DESTRUCTIVE_PATTERNS.test(cmd)) return { allowed: false, category, reason: 'destructive command pattern refused', requiresApproval: false };
      if (/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/.test(cmd)) return { allowed: false, category, reason: 'piping downloads into a shell is refused', requiresApproval: false };
    }

    // DESTRUCTIVE requires explicit owner confirmation
    if (category === 'DESTRUCTIVE' && !action.ownerConfirmed) {
      return { allowed: false, category, reason: 'DESTRUCTIVE operation requires explicit owner confirmation (ownerConfirmed)', requiresApproval: true };
    }

    return { allowed: true, category, reason: category === 'UI_AUTOMATION' ? 'ui automation (rate-limited, non-flooded)' : 'allowed', requiresApproval: false };
  }
}
