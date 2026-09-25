import { useState } from 'react';
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
        <div className="sidebar-footer">
          <span className={`dot ${j.connected ? 'on' : 'off'}`} /> {j.connected ? 'Core online' : 'Core offline'}
        </div>
      </nav>

      <main className="main" aria-label="JARVIS content">
        {view.page === 'dashboard' && <Dashboard j={j} />}
        {view.page === 'tasks' && <Tasks onOpen={(id) => nav({ page: 'task-detail', id })} />}
        {view.page === 'task-detail' && <TaskDetail id={view.id} onBack={() => nav({ page: 'tasks' })} />}
        {view.page === 'projects' && <Projects />}
        {view.page === 'settings' && <SettingsPage settings={j.settings} onSaved={j.setSettings} />}
        {view.page === 'logs' && <Logs />}
      </main>
    </div>
  );
}
