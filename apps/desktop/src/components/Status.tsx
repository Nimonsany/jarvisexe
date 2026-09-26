import type { Task, TaskStatus } from '../types';
import { STATUS_DISPLAY, pipelineMark, PIPELINE } from '../types';

const MARK = { done: '✓', active: '●', pending: '○', bad: '✗' } as const;

export function StatusPill({ status }: { status: TaskStatus }) {
  const d = STATUS_DISPLAY[status] ?? { label: status, mark: 'pending' as const };
  return <span className={`pill ${d.mark}`}>{MARK[d.mark]} {d.label}</span>;
}

export function Pipeline({ task }: { task: Task | null }) {
  return (
    <div className="pipeline" role="list" aria-label="Task pipeline">
      {PIPELINE.map((s) => {
        const m = pipelineMark(task, s);
        return (
          <div key={s} role="listitem" className={`pipeline-step ${m}`}>
            <span className="mark">{MARK[m]}</span> {STATUS_DISPLAY[s].label}
          </div>
        );
      })}
    </div>
  );
}

export function ActivityList({ events, limit = 30 }: { events: import('../types').TaskEvent[]; limit?: number }) {
  const shown = events.slice(-limit).reverse();
  if (!shown.length) return <p className="muted">No activity yet.</p>;
  return (
    <ul className="activity" aria-label="Activity timeline">
      {shown.map((e, i) => (
        <li key={i} className={`sev-${e.severity}`}>
          <span className="ts">{e.timestamp.slice(11, 19)}</span>
          <span className="comp">{e.component}</span>
          <span className="ev">{humanEvent(e)}</span>
        </li>
      ))}
    </ul>
  );
}

// Short human descriptions for common events
export function humanEvent(e: import('../types').TaskEvent): string {
  const map: Record<string, string> = {
    task_created: 'Task created',
    state_new_to_planning: 'Opening ChatGPT',
    state_planning_to_waiting_for_chatgpt: 'Planning prompt submitted',
    master_prompt_extracted: 'Plan received (master prompt)',
    fallback_prompt_generated: 'Plan received (fallback prompt)',
    state_plan_received_to_preparing_execution: 'Preparing execution',
    session_start: 'OpenCode execution started',
    session_exit: 'OpenCode run finished',
    self_repair_attempt: 'JARVIS self-repair attempt',
    consulting_chatgpt_for_debug: 'Consulting ChatGPT for a corrective plan',
    pause_requested: 'Paused',
    task_resumed: 'Resumed',
    paused_at_checkpoint: 'Paused at safe checkpoint',
    task_cancelled: 'Cancelled',
    opencode_killed: 'OpenCode stopped',
    computer_processes_killed: 'Controlled processes stopped',
    task_completed: 'Task completed',
    task_failed: 'Task failed',
    escalated_to_owner: 'Waiting for owner decision',
    'computer.action.denied': 'Action refused by security policy',
    'computer.action.dry_run': 'Dry run (no changes)',
  };
  if (map[e.event]) {
    const d = e.data as { attempt?: number; cycle?: number; killed?: number } | undefined;
    if (e.event === 'self_repair_attempt' && d?.attempt) return `${map[e.event]} ${d.attempt}/2`;
    if (e.event === 'consulting_chatgpt_for_debug' && d?.cycle) return `${map[e.event]} (cycle ${d.cycle})`;
    if (e.event === 'computer_processes_killed' && d?.killed) return `${map[e.event]} (${d.killed})`;
    return map[e.event];
  }
  // computer control actions: computer.<capability>.<operation>.started/completed
  const cm = e.event.match(/^computer\.(\w+)\.(\w+)\.(started|completed)$/);
  if (cm) {
    const capLabel: Record<string, string> = { terminal: 'Terminal', filesystem: 'Filesystem', applications: 'Application', clipboard: 'Clipboard', screen: 'Screen', keyboard: 'Keyboard', mouse: 'Mouse' };
    const opLabel: Record<string, string> = { run: 'Running command', mkdir: 'Created folder', write: 'Wrote file', read: 'Read file', launch: 'Opened app', detect: 'Checked app', capture: 'Captured screen' };
    const verb = cm[3] === 'started' ? (opLabel[cm[2]] ?? cm[2]) : `${opLabel[cm[2]] ?? cm[2]} — done`;
    return `${capLabel[cm[1]] ?? cm[1]}: ${verb}`;
  }
  if (e.event.startsWith('state_')) {
    const parts = e.event.split('_to_');
    const toState = (parts[1] ?? '').toUpperCase();
    return STATUS_DISPLAY[toState as TaskStatus]?.label ?? e.event;
  }
  return e.event;
}

/** Computer Activity: capability-grouped computer-control events for the dashboard. */
export function ComputerActivity({ events, limit = 12 }: { events: import('../types').TaskEvent[]; limit?: number }) {
  const shown = events.filter((e) => e.component === 'computer').slice(-limit).reverse();
  if (!shown.length) return <p className="muted">No computer activity yet.</p>;
  return (
    <ul className="activity" aria-label="Computer activity">
      {shown.map((e, i) => (
        <li key={i} className={`sev-${e.severity}`}>
          <span className="ts">{e.timestamp.slice(11, 19)}</span>
          <span className="comp">Computer</span>
          <span className="ev">{humanEvent(e)}</span>
        </li>
      ))}
    </ul>
  );
}
