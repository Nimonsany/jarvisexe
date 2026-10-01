/** E2E driver bridge (M8 GUI clean-install E2E).
 *
 *  Activated ONLY when the desktop shell injects `window.__JARVIS_E2E__`
 *  (Rust setup, env-gated on JARVIS_E2E carrying the harness URL). Production
 *  runs never set the env → no bridge object exists and this module is inert.
 *
 *  The harness queues DOM commands over loopback HTTP; the driver executes
 *  them inside the real webview, so the packaged UI itself performs every
 *  step (typing, clicking, reading status) — no direct API task submission. */

declare global {
  interface Window {
    __JARVIS_E2E__?: string;
    __jarvisE2EDriver?: boolean;
  }
}

type Cmd = { id: string; cmd: string; sel?: string; value?: string; text?: string; timeoutMs?: number };
type Done = { id: string; ok: boolean; value?: string; error?: string };

const base = (): string | null => (typeof window !== 'undefined' ? window.__JARVIS_E2E__ ?? null : null);

// Per-instance key on /cmd GETs: lets the harness tell WHICH app instance is
// polling (a stale instance surviving stop would otherwise be indistinguishable).
const KEY = Math.random().toString(36).slice(2, 8);

async function send(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    mode: 'cors',
    // Abort hung sockets: a fetch that never resolves would otherwise wedge the
    // poll loop forever (WebKit network stalls under system load did exactly that).
    signal: AbortSignal.timeout(5_000),
  });
}

/** /done loss is fatal (the harness shift()s on fetch): retry a few times. */
async function sendDone(d: Done): Promise<void> {
  for (let i = 0; i < 4; i++) {
    try { await send('/done', d); return; }
    catch { await new Promise((r) => setTimeout(r, 400)); }
  }
}

function find(sel: string): Element | null {
  try { return document.querySelector(sel); } catch { return null; }
}

/** React-controlled inputs need the native value setter + a bubbling input event. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else (el as HTMLInputElement).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function exec(c: Cmd): Promise<string> {
  const deadline = Date.now() + (c.timeoutMs ?? 20_000);
  for (;;) {
    if (c.cmd === 'wait' || c.cmd === 'wait_testid') {
      const el = c.sel ? find(c.sel) : null;
      const textOk = c.text ? document.body.innerText.includes(c.text) : true;
      if ((c.sel ? el !== null : true) && textOk) {
        return ((c.sel && el ? el.textContent : document.body.innerText) ?? 'ok').slice(0, 4000);
      }
    } else if (c.cmd === 'set') {
      const el = c.sel ? (find(c.sel) as HTMLInputElement | HTMLTextAreaElement | null) : null;
      if (el) { el.focus(); setNativeValue(el, c.value ?? ''); return 'ok'; }
    } else if (c.cmd === 'click') {
      let el: Element | null = c.sel ? find(c.sel) : null;
      if (!el && c.text) {
        el = [...document.querySelectorAll<HTMLElement>('button, a, [role="button"], [role="tab"]')]
          .find((e) => (e.textContent ?? '').trim() === c.text) ?? null;
      }
      if (el) { (el as HTMLElement).click(); return 'ok'; }
    } else if (c.cmd === 'get') {
      if (c.sel) {
        const els = [...document.querySelectorAll(c.sel)];
        const want = c.text;
        const hit = want ? els.find((e) => (e.textContent ?? '').includes(want)) : els[0];
        if (hit) { const t = (hit.textContent ?? '').trim(); if (t) return t.slice(0, 4000); }
      }
      if (c.text && document.body.innerText.includes(c.text)) return c.text;
    } else if (c.cmd === 'body') {
      return document.body.innerText.slice(0, 12_000);
    } else if (c.cmd === 'app_version') {
      // M9 updater E2E: tauri.conf version as the RUNNING app sees it
      // (proves which build survived an update install + relaunch).
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    } else {
      return `unknown cmd: ${c.cmd}`;
    }
    if (Date.now() > deadline) {
      throw new Error(`driver timeout: ${c.cmd} sel=${c.sel ?? '-'} text=${c.text ?? '-'}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function startE2EDriver(): void {
  if (typeof window === 'undefined' || window.__jarvisE2EDriver) return;
  // The shell's eval may land just before/after the document loads; poll for
  // the injected URL for up to 60s before concluding we're in production.
  const t0 = Date.now();
  const tick = (): void => {
    if (window.__jarvisE2EDriver) return;
    if (!base()) {
      if (Date.now() - t0 < 60_000) setTimeout(tick, 250);
      return;
    }
    window.__jarvisE2EDriver = true;
    void (async () => {
      for (;;) {
        try {
          // t = page load instant: lets the harness reject pages from BEFORE the
          // current launch — a killed app's orphaned WebKit WebContent process
          // (argv=/System, invisible to path-based pgrep) can keep polling, and
          // would otherwise steal commands from the freshly launched app.
          const r = await send(`/cmd?k=${KEY}&t=${Math.floor(performance.timeOrigin)}`);
          if (r.ok) {
            const c = (await r.json()) as Cmd | null;
            if (c && c.id) {
              try {
                const value = await exec(c);
                const done: Done = { id: c.id, ok: true, value };
                await sendDone(done);
              } catch (e) {
                const done: Done = { id: c.id, ok: false, error: String(e instanceof Error ? e.message : e) };
                await sendDone(done);
              }
              continue; // drain the queue without sleeping
            }
          }
        } catch { /* harness not reachable yet */ }
        await new Promise((r) => setTimeout(r, 150));
      }
    })();
  };
  tick();
}
