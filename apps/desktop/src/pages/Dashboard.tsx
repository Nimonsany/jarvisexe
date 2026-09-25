import { TaskInput, CurrentTaskPanel, ErrorBanner, HealthBar } from '../components/Panels';
import { Pipeline, ActivityList } from '../components/Status';
import type { useJarvis } from '../hooks/useJarvis';

export function Dashboard({ j }: { j: ReturnType<typeof useJarvis> }) {
  return (
    <div className="page">
      <HealthBar health={j.health} onLogin={j.openChatGPTLogin} />
      <h1>JARVIS</h1>
      <p className="muted tagline">Local autonomous computer orchestrator</p>

      <TaskInput onSubmit={(request, project) => j.createTask(request, project)} busy={j.busy} />

      <h2>Current Task</h2>
      <Pipeline task={j.currentTask} />
      <CurrentTaskPanel task={j.currentTask} onPause={(id) => j.pause(id)} onStop={(id) => j.stop(id)} onOpenTask={j.openTask} />
      <ErrorBanner task={j.currentTask} />

      <h2>Activity</h2>
      <ActivityList events={j.events} />
    </div>
  );
}
