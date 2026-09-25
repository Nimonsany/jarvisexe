import { useEffect, useState } from 'react';
import { JarvisClient } from '../services/JarvisClient';
import { ActivityList, StatusPill } from '../components/Status';
import type { Task, TaskEvent } from '../types';

export function TaskDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => JarvisClient.getTask(id).then(({ task, events }) => { if (alive) { setTask(task); setEvents(events); } }).catch(() => {});
    load();
    const unsub = JarvisClient.subscribeToEvents((e) => { if (e.task_id === id) load(); });
    return () => { alive = false; unsub(); };
  }, [id]);

  if (!task) return <div className="page"><p className="muted">Loading… or task not found.</p><button onClick={onBack}>Back</button></div>;

  return (
    <div className="page">
      <button onClick={onBack} aria-label="Back to tasks">← Back</button>
      <header className="detail-header">
        <h1>{task.id}</h1>
        <StatusPill status={task.status} />
      </header>
      <p className="request">“{task.owner_request}”</p>
      <div className="detail-grid">
        <section className="panel">
          <h2>Details</h2>
          <dl>
            <dt>Phase</dt><dd>{task.current_phase}</dd>
            <dt>Project</dt><dd className="mono">{task.project_directory}</dd>
            <dt>OpenCode session</dt><dd className="mono">{task.opencode_session ?? '—'}</dd>
            <dt>Self-repair attempts</dt><dd>{task.retry_count}</dd>
            <dt>ChatGPT cycles</dt><dd>{task.chatgpt_cycle_count}</dd>
            <dt>Verification</dt><dd>{task.verification_status}</dd>
            <dt>Started</dt><dd>{task.created_at.replace('T', ' ').slice(0, 19)}</dd>
            <dt>Last update</dt><dd>{task.updated_at.replace('T', ' ').slice(0, 19)}</dd>
          </dl>
        </section>
        <section className="panel">
          <h2>Result</h2>
          {task.result
            ? <p className="ok-text">{task.result}</p>
            : task.last_error
              ? <p className="err-text mono">{task.last_error}</p>
              : <p className="muted">In progress…</p>}
        </section>
      </div>
      <h2>Timeline</h2>
      <ActivityList events={events} limit={100} />
    </div>
  );
}
