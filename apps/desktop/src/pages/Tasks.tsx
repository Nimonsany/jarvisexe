import { useEffect, useState } from 'react';
import { JarvisClient } from '../services/JarvisClient';
import { ActivityList, StatusPill } from '../components/Status';
import type { Task } from '../types';

export function Tasks({ onOpen }: { onOpen: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => JarvisClient.listTasks()
      .then((t) => { if (alive) setTasks(t); })
      .catch(() => { /* transient — next tick retries */ });
    load();
    // ponytail: poll — a one-shot fetch that timed out left this page forever
    // empty ("No tasks yet") under load; retry-on-reject + tick covers it.
    const iv = setInterval(load, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  return (
    <div className="page">
      <h1>Tasks</h1>
      {tasks.length === 0 && <p className="muted">No tasks yet.</p>}
      <table className="task-table" aria-label="Task history">
        <thead>
          <tr><th>ID</th><th>Request</th><th>Status</th><th>Created</th><th>Project</th></tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} onClick={() => onOpen(t.id)} tabIndex={0} role="button"
              onKeyDown={(e) => { if (e.key === 'Enter') onOpen(t.id); }}>
              <td className="mono">{t.id}</td>
              <td className="request-cell">{t.owner_request.slice(0, 70)}{t.owner_request.length > 70 ? '…' : ''}</td>
              <td><StatusPill status={t.status} /></td>
              <td className="muted">{t.created_at.slice(0, 16).replace('T', ' ')}</td>
              <td className="muted mono">{t.project_directory.split('/').slice(-1)[0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
