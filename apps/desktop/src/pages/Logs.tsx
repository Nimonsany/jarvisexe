import { useEffect, useMemo, useState } from 'react';
import { JarvisClient } from '../services/JarvisClient';
import { humanEvent } from '../components/Status';
import { sanitize } from '../utils/sanitize';
import type { TaskEvent } from '../types';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'core', label: 'JARVIS' },
  { key: 'planner', label: 'ChatGPT' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'verifier', label: 'Verifier' },
  { key: 'security', label: 'Security' },
  { key: 'error', label: 'Errors' },
] as const;

export function Logs() {
  const [all, setAll] = useState<TaskEvent[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const [limit, setLimit] = useState(200);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const tasks = await JarvisClient.listTasks();
        const events: TaskEvent[] = [];
        for (const t of tasks.slice(0, 20)) {
          const { events: ev } = await JarvisClient.getTask(t.id);
          events.push(...ev);
        }
        events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        if (alive) setAll(events);
      } catch { /* core offline */ }
    };
    load();
    const unsub = JarvisClient.subscribeToEvents(() => load());
    return () => { alive = false; unsub(); };
  }, []);

  // Redact before UI display in case upstream data contains secrets
  const shown = useMemo(() => {
    const filtered = all.filter((e) => {
      if (filter === 'all') return true;
      if (filter === 'error') return e.severity === 'error' || e.severity === 'warning';
      return e.component === filter;
    });
    return filtered.slice(-limit).map((e) => ({
      ...e,
      event: sanitize(humanEvent(e)),
      dataStr: e.data ? sanitize(JSON.stringify(e.data)) : '',
    }));
  }, [all, filter, limit]);

  return (
    <div className="page">
      <h1>Logs</h1>
      <div className="filters" role="tablist" aria-label="Log filters">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key}
            className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="muted">No events.</p>}
      <div className="logview" aria-label="Operational logs">
        {shown.map((e, i) => (
          <div key={i} className={`logline sev-${e.severity}`}>
            <span className="ts">{e.timestamp.slice(11, 19)}</span>
            <span className="comp">{e.component}</span>
            <span className="ev">{e.event}</span>
            {e.dataStr && <span className="data">{e.dataStr.slice(0, 120)}</span>}
          </div>
        ))}
      </div>
      {all.length > limit && <button onClick={() => setLimit(limit + 500)}>Load more</button>}
    </div>
  );
}
