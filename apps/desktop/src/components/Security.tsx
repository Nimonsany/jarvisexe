import type { PendingApproval } from '../types';

export function ApprovalRequests({
  approvals, onDecide,
}: {
  approvals: PendingApproval[];
  onDecide: (id: string, approved: boolean) => void;
}) {
  const pending = approvals.filter((a) => a.status === 'pending');
  if (!pending.length) return null;
  return (
    <section className="panel waiting" aria-label="Owner approval required">
      <h2>🔐 Owner approval required</h2>
      {pending.map((a) => (
        <div key={a.id} className="approval-item">
          <p><strong>{a.capability}</strong>: <span className="mono">{a.operation.slice(0, 120)}</span></p>
          <p className="muted">Reason: {a.reason} · Risk: {a.riskLevel} (level {a.level}) · Requested {a.requestedAt.slice(11, 19)}</p>
          <div className="controls">
            <button className="primary" onClick={() => onDecide(a.id, true)} aria-label={`Approve ${a.operation}`}>Approve</button>
            <button className="danger" onClick={() => onDecide(a.id, false)} aria-label={`Reject ${a.operation}`}>Reject</button>
          </div>
        </div>
      ))}
    </section>
  );
}

export function EmergencyStopBar({
  stopped, onEmergencyStop, onClear,
}: {
  stopped: boolean;
  onEmergencyStop: () => void;
  onClear: () => void;
}) {
  if (stopped) {
    return (
      <div className="healthbar emergency" role="alert">
        <span className="dot off" /> <strong>EMERGENCY STOP</strong> — JARVIS will not start new work. Press Resume to continue.
        <button className="primary small" onClick={onClear} aria-label="Clear emergency stop">Resume JARVIS</button>
      </div>
    );
  }
  return (
    <div className="healthbar">
      <button className="danger small" onClick={onEmergencyStop} aria-label="Emergency stop JARVIS (Cmd+Shift+F12)">
        ⛔ STOP JARVIS
      </button>
      <span className="muted">kill switch: ⌘/Ctrl + Shift + F12</span>
    </div>
  );
}
