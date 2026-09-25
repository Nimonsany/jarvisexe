import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ActionResult } from './types.js';

/** macOS adapter: native screencapture. Screenshots are sensitive:
 *  stored temporarily under runtime/screenshots with a cleanup policy
 *  (deleted after 30 minutes); never auto-uploaded anywhere. */
export class ScreenController {
  constructor(private screenshotDir: string) {}

  capture(args: { displayId?: number } = {}): ActionResult & { data?: string } {
    const t0 = Date.now();
    try {
      mkdirSync(this.screenshotDir, { recursive: true });
      this.cleanup(); // cleanup policy on every capture
      const file = path.join(this.screenshotDir, `screen-${Date.now()}.png`);
      const args2 = ['-x']; // silent
      if (args.displayId) args2.push('-D', String(args.displayId));
      args2.push(file);
      execFileSync('screencapture', args2, { timeout: 15000 });
      if (!existsSync(file)) throw new Error('screencapture produced no file');
      return { success: true, tool: 'screen', action: 'capture', durationMs: Date.now() - t0, data: file, metadata: { path: file, bytes: statSync(file).size, cleanupPolicy: 'delete after 30 min' } };
    } catch (e) {
      return { success: false, tool: 'screen', action: 'capture', durationMs: Date.now() - t0, error: String(e instanceof Error ? e.message : e) };
    }
  }

  /** Delete screenshots older than 30 minutes. */
  private cleanup(): void {
    if (!existsSync(this.screenshotDir)) return;
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const f of readdirSync(this.screenshotDir)) {
      const p = path.join(this.screenshotDir, f);
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* gone */ }
    }
  }
}
