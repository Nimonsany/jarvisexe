import { TaskInput, CurrentTaskPanel, ErrorBanner, HealthBar } from '../components/Panels';
import { Pipeline, ActivityList, ComputerActivity } from '../components/Status';
import { ApprovalRequests, EmergencyStopBar } from '../components/Security';
import { JarvisClient } from '../services/JarvisClient';
import type { useJarvis } from '../hooks/useJarvis';

export function Dashboard({ j }: { j: ReturnType<typeof useJarvis> }) {
  return (
    <div className="page">
      <HealthBar health={j.health} onLogin={j.openChatGPTLogin} />
      <EmergencyStopBar stopped={j.emergencyStopped} onEmergencyStop={j.emergencyStop} onClear={j.clearEmergencyStop} />
      <h1>JARVIS</h1>
      <p className="muted tagline">Local autonomous computer orchestrator</p>

      <ApprovalRequests approvals={j.approvals} onDecide={j.decideApproval} />
      <TaskInput
        onSubmit={(request, project) => j.createTask(request, project)}
        busy={j.busy}
        onPushToTalk={() => JarvisClient.pushToTalk(8000).then((r) => r.command ?? r.text).catch((e) => { throw e; })}
      />

      <h2>Current Task</h2>
      <Pipeline task={j.currentTask} />
      <CurrentTaskPanel task={j.currentTask} onPause={(id) => j.pause(id)} onStop={(id) => j.stop(id)} onOpenTask={j.openTask} />
      <ErrorBanner task={j.currentTask} />

      <h2>Computer Activity</h2>
      <ComputerActivity events={j.events} />

      <h2>Activity</h2>
      <ActivityList events={j.events} />
    </div>
  );
}
