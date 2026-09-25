import { execFileSync } from 'node:child_process';
import type { ActionResult } from './types.js';

/**
 * macOS adapter: System Events via osascript (Accessibility permission may be
 * required — macOS will prompt). LAST fallback in the tool priority; prefer
 * deterministic interfaces. Typing is focus-aware: the caller must ensure the
 * target window is foreground first (applications.activate).
 */
export class KeyboardMouseController {
  private osa(script: string, timeoutMs = 15000): { ok: boolean; out: string } {
    try {
      const out = execFileSync('osascript', ['-e', script], { timeout: timeoutMs, encoding: 'utf8' });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return { ok: false, out: err.stderr ?? err.message ?? '' };
    }
  }

  // keyboard
  type(args: { text: string }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'keyboard', action: 'type', durationMs: 0, metadata: { chars: args.text.length, dryRun: true } };
    // escape for AppleScript string literal
    const esc = args.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const r = this.osa(`tell application "System Events" to keystroke "${esc}"`);
    return { success: r.ok, tool: 'keyboard', action: 'type', durationMs: Date.now() - t0, metadata: { chars: args.text.length }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  press(args: { key: string }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'keyboard', action: 'press', durationMs: 0, metadata: { key: args.key, dryRun: true } };
    const allowed = /^[a-zA-Z0-9]$|^(return|enter|tab|space|delete|escape|up|down|left|right|f\d{1,2})$/i.test(args.key);
    if (!allowed) return { success: false, tool: 'keyboard', action: 'press', durationMs: Date.now() - t0, error: `key not allowed: ${args.key}` };
    const r = this.osa(`tell application "System Events" to key code ${keyNameToCode(args.key)}`);
    return { success: r.ok, tool: 'keyboard', action: 'press', durationMs: Date.now() - t0, metadata: { key: args.key }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  combo(args: { keys: string[] }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'keyboard', action: 'combo', durationMs: 0, metadata: { keys: args.keys, dryRun: true } };
    const mods = args.keys.filter((k) => /^(command|cmd|control|ctrl|option|alt|shift|fn)$/i.test(k));
    const rest = args.keys.filter((k) => !mods.includes(k));
    if (rest.length !== 1) return { success: false, tool: 'keyboard', action: 'combo', durationMs: Date.now() - t0, error: 'combo = modifiers + exactly one key' };
    const modList = mods.map((m) => m.toLowerCase().replace('cmd', 'command').replace('ctrl', 'control').replace('alt', 'option')).join(' & ');
    const r = this.osa(`tell application "System Events" to keystroke "${rest[0]}" using {${modList} down}`);
    return { success: r.ok, tool: 'keyboard', action: 'combo', durationMs: Date.now() - t0, metadata: { keys: args.keys }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  // mouse (raw coordinates = last fallback; obtain geometry first, never blind sequences)
  move(args: { x: number; y: number }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'mouse', action: 'move', durationMs: 0, metadata: { x: args.x, y: args.y, dryRun: true } };
    const r = this.osa(`tell application "System Events" to set position of the mouse to {${Math.round(args.x)}, ${Math.round(args.y)}}`) ;
    // CGEventPost via osascript is unavailable; use Python Quartz fallback if present
    const result = r.ok ? r : this.pyMouse(['move', String(args.x), String(args.y)]);
    return { success: result.ok, tool: 'mouse', action: 'move', durationMs: Date.now() - t0, metadata: { x: args.x, y: args.y }, ...(result.ok ? {} : { error: result.out.slice(0, 200) }) };
  }

  click(args: { x: number; y: number; button?: 'left' | 'right'; double?: boolean }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'mouse', action: args.double ? 'double-click' : args.button === 'right' ? 'right-click' : 'click', durationMs: 0, metadata: { x: args.x, y: args.y, dryRun: true } };
    const kind = args.double ? 'double' : args.button === 'right' ? 'right' : 'left';
    const result = this.pyMouse([kind + '-click', String(args.x), String(args.y)]);
    return { success: result.ok, tool: 'mouse', action: args.double ? 'double-click' : args.button === 'right' ? 'right-click' : 'click', durationMs: Date.now() - t0, metadata: { x: args.x, y: args.y }, ...(result.ok ? {} : { error: result.out.slice(0, 200) }) };
  }

  scroll(args: { dx: number; dy: number }): ActionResult {
    const t0 = Date.now();
    const result = this.pyMouse(['scroll', String(args.dx), String(args.dy)]);
    return { success: result.ok, tool: 'mouse', action: 'scroll', durationMs: Date.now() - t0, metadata: { dx: args.dx, dy: args.dy }, ...(result.ok ? {} : { error: result.out.slice(0, 200) }) };
  }

  drag(args: { fromX: number; fromY: number; toX: number; toY: number }): ActionResult {
    const t0 = Date.now();
    const result = this.pyMouse(['drag', String(args.fromX), String(args.fromY), String(args.toX), String(args.toY)]);
    return { success: result.ok, tool: 'mouse', action: 'drag', durationMs: Date.now() - t0, metadata: { from: [args.fromX, args.fromY], to: [args.toX, args.toY] }, ...(result.ok ? {} : { error: result.out.slice(0, 200) }) };
  }

  private pyMouse(parts: string[]): { ok: boolean; out: string } {
    // Quartz (pyobjc) helper — present on macOS with Python; graceful failure otherwise
    try {
      const out = execFileSync('python3', ['-c', PY_MOUSE_SCRIPT, ...parts], { timeout: 10000, encoding: 'utf8' });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return { ok: false, out: (err.stderr ?? err.message ?? '').slice(0, 200) };
    }
  }
}

function keyNameToCode(key: string): number {
  const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, escape: 53, up: 126, down: 125, left: 123, right: 124 };
  if (/^\d$/.test(key)) return 18 + Number(key); // digits 1-0 row: approximate mapping
  if (/^f\d{1,2}$/i.test(key)) return 122 + Number(key.slice(1)); // F1=122...
  return codes[key.toLowerCase()] ?? 0;
}

const PY_MOUSE_SCRIPT = `
import sys
import time
op = sys.argv[1]
try:
    from Quartz import (CGEventCreateMouseEvent, CGEventPost, kCGEventMouseMoved,
        kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGEventRightMouseDown, kCGEventRightMouseUp,
        kCGHIDEventTap, kCGMouseButtonLeft, kCGMouseButtonRight,
        CGEventCreateScrollWheelEvent, kCGScrollEventUnitPixel)
    def post(t, x, y, btn=kCGMouseButtonLeft):
        e = CGEventCreateMouseEvent(None, t, (x, y), btn)
        CGEventPost(kCGHIDEventTap, e)
    if op == 'move':
        post(kCGEventMouseMoved, float(sys.argv[2]), float(sys.argv[3]))
    elif op == 'left-click' or op == 'double-click':
        x, y = float(sys.argv[2]), float(sys.argv[3])
        post(kCGEventMouseMoved, x, y)
        n = 2 if op == 'double-click' else 1
        for _ in range(n):
            post(kCGEventLeftMouseDown, x, y); post(kCGEventLeftMouseUp, x, y); time.sleep(0.05)
    elif op == 'right-click':
        x, y = float(sys.argv[2]), float(sys.argv[3])
        post(kCGEventMouseMoved, x, y)
        post(kCGEventRightMouseDown, x, y, kCGMouseButtonRight); post(kCGEventRightMouseUp, x, y, kCGMouseButtonRight)
    elif op == 'scroll':
        e = CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitPixel, 1, int(sys.argv[3]))
        CGEventPost(kCGHIDEventTap, e)
    elif op == 'drag':
        x1, y1, x2, y2 = map(float, sys.argv[2:6])
        post(kCGEventMouseMoved, x1, y1)
        post(kCGEventLeftMouseDown, x1, y1)
        steps = 20
        for i in range(1, steps + 1):
            post(kCGEventMouseMoved, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
            time.sleep(0.01)
        post(kCGEventLeftMouseUp, x2, y2)
    print('ok')
except ImportError:
    sys.stderr.write('Quartz not available')
    sys.exit(1)
`;
