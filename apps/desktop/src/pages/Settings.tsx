import { useEffect, useState } from 'react';
import { JarvisClient, setDeviceToken } from '../services/JarvisClient';
import type { Settings } from '../types';

export function SettingsPage({ settings, onSaved }: { settings: Settings | null; onSaved: (s: Settings) => void }) {
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [msg, setMsg] = useState<string | null>(null);
  const [tokenShown, setTokenShown] = useState<string | null>(null);
  const [deviceToken, setTokenInput] = useState('');
  useEffect(() => { if (!draft && settings) setDraft(settings); }, [settings, draft]);
  if (!draft) return <div className="page"><p className="muted">Loading settings…</p></div>;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });

  const save = async () => {
    setMsg(null);
    try {
      const saved = await JarvisClient.updateSettings(draft);
      onSaved(saved);
      setMsg('Saved. If remote access was enabled, restart the core server to bind the Tailscale interface.');
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    }
  };

  const revealToken = async () => {
    try {
      const r = await fetch('http://127.0.0.1:7788/api/bootstrap');
      if (r.ok) setTokenShown(((await r.json()) as { token: string }).token);
      else setTokenShown('Local-only — available on the JARVIS machine.');
    } catch { setTokenShown('Core offline.'); }
  };

  const saveDeviceToken = () => {
    if (!deviceToken.trim()) return;
    setDeviceToken(deviceToken);
    setMsg('Device token saved for this browser.');
  };

  return (
    <div className="page">
      <h1>Settings</h1>
      <div className="settings-grid">
        <label>Default project directory
          <input type="text" value={draft.defaultProjectDir} onChange={(e) => set('defaultProjectDir', e.target.value)} />
        </label>
        <label>OpenCode executable
          <input type="text" value={draft.opencodeBin} onChange={(e) => set('opencodeBin', e.target.value)} />
        </label>
        <label>Browser channel
          <select value={draft.browserChannel} onChange={(e) => set('browserChannel', e.target.value)}>
            <option value="chrome">Chrome</option>
            <option value="chromium">Chromium</option>
          </select>
        </label>
        <label>Visible browser mode
          <input type="checkbox" checked={!draft.headless} onChange={(e) => set('headless', !e.target.checked)} />
        </label>
        <label>Automatic ChatGPT consultation threshold (self-repair attempts first)
          <input type="number" min={1} max={5} value={draft.autoConsultThreshold} onChange={(e) => set('autoConsultThreshold', Number(e.target.value))} />
        </label>
        <label>Maximum ChatGPT correction cycles
          <input type="number" min={1} max={10} value={draft.maxRetries} onChange={(e) => set('maxRetries', Number(e.target.value))} />
        </label>
        <label>Final ChatGPT review (not active yet)
          <input type="checkbox" checked={draft.finalReview} disabled onChange={(e) => set('finalReview', e.target.checked)} />
        </label>
        <label>Start minimized (not active yet)
          <input type="checkbox" checked={draft.startMinimized} disabled onChange={(e) => set('startMinimized', e.target.checked)} />
        </label>
        <label>Theme
          <select value={draft.theme} onChange={(e) => set('theme', e.target.value as 'dark' | 'light')}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>Remote access (Tailscale, token-gated — restart the core server after changing)
          <input type="checkbox" checked={draft.remoteAccess} onChange={(e) => set('remoteAccess', e.target.checked)} />
        </label>
        <label>Log verbosity (not active yet)
          <select value={draft.logVerbosity} onChange={(e) => set('logVerbosity', e.target.value as Settings['logVerbosity'])}>
            <option value="quiet">Quiet</option>
            <option value="normal">Normal</option>
            <option value="verbose">Verbose</option>
          </select>
        </label>
      </div>
      <div className="controls">
        <button className="primary" onClick={save}>Save settings</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <h2>Remote device authorization</h2>
      <p className="muted">A remote device (e.g. over Tailscale) must present this token for every request. Enter it once on the remote device.</p>
      <div className="controls">
        <button onClick={revealToken}>Show device token</button>
        {tokenShown && <span className="mono">{tokenShown.slice(0, 20)}…</span>}
      </div>
      <div className="controls">
        <input type="text" placeholder="Paste device token on THIS device (remote setups)" value={deviceToken} onChange={(e) => setTokenInput(e.target.value)} aria-label="Device token" />
        <button onClick={saveDeviceToken}>Save device token</button>
      </div>
      <p className="muted">Secrets are never stored here. ChatGPT login lives only in the dedicated browser profile.</p>
    </div>
  );
}
