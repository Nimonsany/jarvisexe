import { useEffect, useState } from 'react';
import { useJarvis } from './hooks/useJarvis';
import { Dashboard } from './pages/Dashboard';
import { Tasks } from './pages/Tasks';
import { TaskDetail } from './pages/TaskDetail';
import { Projects } from './pages/Projects';
import { SettingsPage } from './pages/Settings';
import { Logs } from './pages/Logs';

type View = { page: 'dashboard' | 'tasks' | 'projects' | 'settings' | 'logs' } | { page: 'task-detail'; id: string };

export default function App() {
  const j = useJarvis();
  const [view, setView] = useState<View>({ page: 'dashboard' });

  const nav = (v: View) => setView(v);

  // KILL SWITCH: Cmd/Ctrl + Shift + F12 → emergency stop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const ok = window.confirm('EMERGENCY STOP JARVIS?\n\nThis stops all new tasks, cancels the current task and terminates controlled child processes.');
        if (ok) void j.emergencyStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [j]);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main navigation">
        <div className="brand">JARVIS</div>
        {([
          ['dashboard', 'Dashboard'],
          ['tasks', 'Tasks'],
          ['projects', 'Projects'],
          ['logs', 'Logs'],
          ['settings', 'Settings'],
        ] as const).map(([key, label]) => (
          <button key={key}
            className={view.page === key ? 'active' : ''}
            aria-current={view.page === key ? 'page' : undefined}
            onClick={() => nav({ page: key })}>
            {label}
          </button>
        ))}
        <div className="sidebar-footer"
          data-testid="core-state"
          role="status"
          title={j.coreError ?? undefined}>
          <span className={`dot ${j.corePhase === 'ready' ? 'on' : 'off'}`} />
          {j.corePhase === 'starting' && 'Starting Core…'}
          {j.corePhase === 'connecting' && 'Connecting…'}
          {j.corePhase === 'ready' && 'Ready'}
          {j.corePhase === 'error' && <>
            Error
            <button onClick={j.retryCore} aria-label="Retry core connection">Retry</button>
          </>}
        </div>
      </nav>

      <main className="main" aria-label="JARVIS content">
        {view.page === 'dashboard' && <Dashboard j={j} onOpenDetail={(id) => nav({ page: 'task-detail', id })} />}
        {view.page === 'tasks' && <Tasks onOpen={(id) => nav({ page: 'task-detail', id })} />}
        {view.page === 'task-detail' && <TaskDetail id={view.id} onBack={() => nav({ page: 'tasks' })} />}
        {view.page === 'projects' && <Projects />}
        {view.page === 'settings' && <SettingsPage settings={j.settings} onSaved={j.setSettings} />}
        {view.page === 'logs' && <Logs />}
      </main>
    </div>
  );
}
