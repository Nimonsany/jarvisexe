import { execFileSync, spawn } from 'node:child_process';
import { ProcessRegistry } from './registry.js';
import type { ActionResult } from './types.js';

/** macOS adapter: native pbpaste/pbcopy. Reads are intentional API calls only;
 *  clipboard contents are NEVER auto-added to logs or prompts. */
export class ClipboardController {
  constructor(private registry: ProcessRegistry) {}

  'clipboard-read'(): ActionResult & { data?: string } {
    const t0 = Date.now();
    try {
      const text = execFileSync('pbpaste', { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      return { success: true, tool: 'clipboard', action: 'clipboard-read', durationMs: Date.now() - t0, data: text, metadata: { bytes: text.length } };
    } catch (e) {
      return { success: false, tool: 'clipboard', action: 'clipboard-read', durationMs: Date.now() - t0, error: String(e) };
    }
  }

  'clipboard-write'(args: { text: string }): ActionResult {
    const t0 = Date.now();
    try {
      const proc = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.stdin?.write(args.text);
      proc.stdin?.end();
      return { success: true, tool: 'clipboard', action: 'clipboard-write', durationMs: Date.now() - t0, metadata: { bytes: args.text.length } };
    } catch (e) {
      return { success: false, tool: 'clipboard', action: 'clipboard-write', durationMs: Date.now() - t0, error: String(e) };
    }
  }

  'clipboard-clear'(): ActionResult {
    return this['clipboard-write']({ text: '' });
  }
}

void ProcessRegistry;
