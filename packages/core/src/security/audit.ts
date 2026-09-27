import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface AuditEntry {
  timestamp: string;
  kind: string;                 // task | computer | security | approval
  taskId: string | null;
  summary: string;              // sanitized, never contains secrets
  detail?: Record<string, unknown>;
  prev?: string;                // hash of the previous entry (tamper-evident chain)
  hash?: string;
}

/**
 * Append-only, tamper-evident audit log: each entry carries the hash of the
 * previous entry. verifyChain() detects any tampering or deletion.
 */
export class AuditLog {
  constructor(private file: string) {}

  private hashEntry(entry: AuditEntry): string {
    const { hash: _ignored, ...rest } = entry;
    void _ignored;
    return createHash('sha256').update(JSON.stringify(rest) + (entry.prev ?? '')).digest('hex');
  }

  append(entry: Omit<AuditEntry, 'hash' | 'prev'>): void {
    try {
      const prev = this.lastHash();
      const withPrev: Omit<AuditEntry, 'hash'> = { ...entry, prev };
      const hash = this.hashEntry(withPrev);
      appendFileSync(this.file, JSON.stringify({ ...withPrev, hash }) + '\n');
    } catch { /* audit must never break execution */ }
  }

  private lastHash(): string | undefined {
    try {
      if (!existsSync(this.file)) return undefined;
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      const last = lines.at(-1);
      return last ? (JSON.parse(last) as AuditEntry).hash : undefined;
    } catch { return undefined; }
  }

  /** Verify the tamper-evident chain; returns { ok, brokenAt } on failure. */
  verifyChain(): { ok: boolean; entries: number; brokenAt?: number } {
    try {
      if (!existsSync(this.file)) return { ok: true, entries: 0 };
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      let prev: string | undefined;
      for (let i = 0; i < lines.length; i++) {
        const e = JSON.parse(lines[i]) as AuditEntry;
        if (e.prev !== prev) return { ok: false, entries: lines.length, brokenAt: i };
        const expected = this.hashEntry(e);
        if (e.hash !== expected) return { ok: false, entries: lines.length, brokenAt: i };
        prev = e.hash;
      }
      return { ok: true, entries: lines.length };
    } catch (e) {
      return { ok: false, entries: 0, brokenAt: -1 };
    }
  }

  entries(): AuditEntry[] {
    try {
      if (!existsSync(this.file)) return [];
      return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
}
