import { useState } from 'react';
import type { Task } from '../types';
import { StatusPill } from './Status';

export function TaskInput({ onSubmit, busy, onPushToTalk, ready = true }: {
  onSubmit: (request: string, project?: string) => void;
  busy: boolean;
  onPushToTalk?: () => Promise<string | null>;
  ready?: boolean;
}) {
  const [value, setValue] = useState('');
  const [project, setProject] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceMsg, setVoiceMsg] = useState<string | null>(null);

  const submit = () => {
    const request = value.trim();
    if (!request || busy) return;
    onSubmit(request, project.trim() || undefined);
    setValue('');
  };

  const mic = async () => {
    if (!onPushToTalk || listening) return;
    setListening(true);
    setVoiceMsg('🎤 Listening… speak now');
    try {
      const r = await onPushToTalk();
      if (r) {
        setValue(r);
        setVoiceMsg(`🗣 "${r.slice(0, 80)}" — press Execute or edit`);
      } else {
        setVoiceMsg('Nothing heard.');
      }
    } catch (e) {
      setVoiceMsg(String(e instanceof Error ? e.message : e).slice(0, 90));
    } finally {
      setListening(false);
    }
  };

  return (
    <div className="task-input">
      <label className="sr-only" htmlFor="task-request">What would you like me to do?</label>
      <input
        id="task-request"
        type="text"
        placeholder="What would you like me to do? (e.g. Create a simple calculator web app)"
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <input
        type="text"
        className="project-field"
        placeholder="Project directory (optional)"
        value={project}
        disabled={busy}
        onChange={(e) => setProject(e.target.value)}
        aria-label="Project directory"
      />
      <button className="primary" onClick={submit} disabled={busy || !ready || !value.trim()} aria-label="Execute task">
        {busy ? 'Starting…' : 'Execute'}
      </button>
      <button className="mic" onClick={mic} disabled={busy || listening} aria-label="Push to talk (microphone)" title="Push to talk">
        {listening ? '⏺' : '🎤'}
      </button>
      {voiceMsg && <p className="muted voice-msg">{voiceMsg}</p>}
    </div>
  );
}

export function CurrentTaskPanel({
  task, onPause, onStop, onOpenTask,
}: {
  task: Task | null;
  onPause: (id: string) => void;
  onStop: (id: string) => void;
  onOpenTask: (id: string) => void;
}) {
  if (!task) return <p className="muted">No active task. Give JARVIS something to do.</p>;
  const active = !['COMPLETED', 'CANCELLED', 'FAILED', 'PAUSED'].includes(task.status);
  return (
    <section className="panel current-task" aria-label="Current task">
      <header>
        <h2 onClick={() => onOpenTask(task.id)} className="task-link" role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter') onOpenTask(task.id); }}>
          {task.id}
        </h2>
        <StatusPill status={task.status} />
      </header>
      <p className="request">“{task.owner_request}”</p>
      <p className="muted mono">{task.project_directory}</p>
      {(task.retry_count > 0 || task.last_error) && (
        <p className="retry muted">
          {task.last_error
            ? <>Last issue: <span className="err-text">{task.last_error.slice(0, 140)}</span></>
            : <>Self-repair attempts so far: {task.retry_count}</>}
        </p>
      )}
      <div className="controls">
        <button onClick={() => onPause(task.id)} disabled={!active} aria-label="Pause task">Pause</button>
        <button className="danger" onClick={() => onStop(task.id)} disabled={!active} aria-label="Stop task">Stop</button>
      </div>
    </section>
  );
}

export function ErrorBanner({ task }: { task: Task | null }) {
  if (!task || !task.last_error) return null;
  if (task.status === 'WAITING_FOR_OWNER') {
    return (
      <section className="panel waiting" aria-label="Waiting for owner">
        <h2>⏸ Waiting for you</h2>
        <p>JARVIS could not resolve this problem on its own:</p>
        <p className="err-text mono">{task.last_error}</p>
        <p className="muted">All automation is paused. Review the evidence, then Resume to retry or Stop to cancel.</p>
      </section>
    );
  }
  const active = ['DEBUGGING', 'EXECUTING', 'MONITORING'].includes(task.status);
  return (
    <section className="panel error" aria-label="Error status" role="status">
      <h2>⚠ {active ? 'Handling a problem' : 'Problem occurred'}</h2>
      <p className="err-text">{task.last_error.slice(0, 200)}</p>
      {active && <p className="muted">JARVIS is applying self-repair / consulting ChatGPT. Watch the activity below.</p>}
    </section>
  );
}

export function HealthBar({ health, onLogin }: { health: import('../types').Health | null; onLogin: () => void }) {
  if (!health) return <div className="healthbar"><span className="dot off" /> JARVIS Core — offline</div>;
  const items: { label: string; state: string; ok: boolean }[] = [
    { label: 'JARVIS Core', state: 'Online', ok: true },
    { label: 'OpenCode', state: health.opencode, ok: health.opencode === 'ready' },
    { label: 'Browser', state: health.chatgptProfile === 'ready' ? 'Ready' : 'Missing', ok: health.chatgptProfile === 'ready' },
    { label: 'ChatGPT', state: health.chatgptLogin === 'ok' ? 'Logged in' : health.chatgptLogin, ok: health.chatgptLogin === 'ok' },
    { label: 'Storage', state: health.storage, ok: health.storage === 'ready' },
  ];
  return (
    <div className="healthbar" aria-label="System status">
      {items.map((i) => (
        <span key={i.label} className={i.ok ? 'ok-item' : 'bad-item'} title={i.state}>
          <span className={`dot ${i.ok ? 'on' : 'off'}`} /> {i.label}: {i.state}
        </span>
      ))}
      {health.chatgptLogin === 'required' && (
        <button className="primary small" onClick={onLogin}>Open ChatGPT Login</button>
      )}
    </div>
  );
}
