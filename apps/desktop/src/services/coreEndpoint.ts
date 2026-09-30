/** Core endpoint discovery — owned by the desktop/runtime layer (BLOCKER 1).
 *
 *  The UI never hardcodes a Core URL. Resolution order:
 *    1. Tauri (packaged/dev webview): Rust command reads the app env (JARVIS_PORT).
 *    2. Standalone browser dev: explicit VITE_JARVIS_CORE_URL from vite env config.
 *    3. Otherwise: CORE_ENDPOINT_UNRESOLVED (surfaced as the Error startup state).
 *
 *  The resolved URL is then identity-checked against JARVIS Core's /api/version
 *  so a wrong process on the port fails fast instead of silently misbehaving. */

export const CORE_IDENTITY = 'jarvis-core';
export const CORE_PROTOCOL = 1;

export type CoreVersion = {
  core?: string;
  protocol?: number;
  version: string;
  commit: string;
  channel: string;
};

/** Injectable for tests: Tauri invoke + env are both swapped out at the seam. */
export type EndpointSources = {
  invoke?: ((cmd: string) => Promise<unknown>) | null;
  envUrl?: string | null;
};

export function defaultSources(): EndpointSources {
  return {
    invoke: async (cmd: string) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke(cmd);
    },
    // cast: this module is also type-checked by the core tsconfig (no vite types)
    envUrl: (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_JARVIS_CORE_URL ?? null,
  };
}

export async function resolveCoreEndpoint(src: EndpointSources = defaultSources()): Promise<string> {
  if (src.invoke) {
    try {
      const base = await src.invoke('jarvis_core_endpoint');
      if (typeof base === 'string' && /^https?:\/\/\S+$/.test(base)) return base.replace(/\/+$/, '');
    } catch {
      /* not a Tauri context (or command failed) — fall through */
    }
  }
  if (src.envUrl && /^https?:\/\/\S+$/.test(src.envUrl)) return src.envUrl.replace(/\/+$/, '');
  throw new Error('CORE_ENDPOINT_UNRESOLVED');
}

/** Resolve + verify identity. Throws CORE_UNAVAILABLE (nothing answering) or
 *  CORE_IDENTITY_MISMATCH (something answering that is not JARVIS Core). */
export async function handshakeCore(
  src: EndpointSources = defaultSources(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ base: string; version: CoreVersion }> {
  const base = await resolveCoreEndpoint(src);
  let r: Response;
  try {
    r = await fetchImpl(`${base}/api/version`);
  } catch {
    throw new Error('CORE_UNAVAILABLE');
  }
  if (!r.ok) throw new Error('CORE_UNAVAILABLE');
  let v: CoreVersion;
  try {
    v = (await r.json()) as CoreVersion;
  } catch {
    throw new Error('CORE_IDENTITY_MISMATCH');
  }
  if (v.core !== CORE_IDENTITY || v.protocol !== CORE_PROTOCOL) throw new Error('CORE_IDENTITY_MISMATCH');
  return { base, version: v };
}
