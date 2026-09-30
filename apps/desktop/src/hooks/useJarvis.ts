import { useCallback, useEffect, useRef, useState } from 'react';
import { JarvisClient, setCoreBase } from '../services/JarvisClient';
import { handshakeCore } from '../services/coreEndpoint';
import type { Task, TaskEvent, Health, Settings } from '../types';

export type CorePhase = 'starting' | 'connecting' | 'ready' | 'error';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Frontend state mirror. Backend is authoritative: everything here is
 *  recoverable by reloading from the core. */
export function useJarvis() {
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentIdRef = useRef<string | null>(null);

  // Startup state machine (deterministic): starting → connecting → ready | error
  const [handshaken, setHandshaken] = useState(false);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const refreshCurrent = useCallback(async (id?: string | null) => {
    const target = id ?? currentIdRef.current;
    if (!target) return;
    try {
      const { task, events: ev } = await JarvisClient.getTask(target);
      setCurrentTask(task);
      setEvents(ev);
    } catch { /* task may be gone */ }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const list = await JarvisClient.listTasks();
      setTasks(list);
      setConnected(true);
      const active = list.find((t) => !['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status));
      if (active && !currentIdRef.current) currentIdRef.current = active.id;
      await refreshCurrent(currentIdRef.current ?? active?.id);
      return true;
    } catch {
      setConnected(false);
      return false;
    }
  }, [refreshCurrent]);

  // BLOCKER 1 — endpoint discovery + identity handshake. Core boots alongside
  // the window, so retry a missing core briefly; identity/endpoint failures are
  // permanent (deterministic Error state, no silent fallback to a wrong URL).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 1; attempt <= 40; attempt++) {
        try {
          const { base } = await handshakeCore();
          if (cancelled) return;
          setCoreBase(base);
          setHandshaken(true);
          return;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (cancelled) return;
          if (msg === 'CORE_UNAVAILABLE' && attempt < 40) {
            await sleep(500);
            continue;
          }
          setCoreError(msg);
          setHandshaken(false);
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [retryToken]);

  // Data load + event subscription only after a successful handshake.
  useEffect(() => {
    if (!handshaken) return;
    let cancelled = false;
    (async () => {
      // first load may race the core's own warm-up — retry up to 60s
      for (let i = 0; i < 60 && !cancelled; i++) {
        const ok = await refreshAll();
        if (cancelled) return;
        if (ok) return;
        await sleep(1000);
      }
      if (!cancelled) setCoreError('CORE_DATA_UNAVAILABLE');
    })();
    JarvisClient.health().then(setHealth).catch(() => setHealth(null));
    JarvisClient.getSettings().then(setSettings).catch(() => {});
    const unsub = JarvisClient.subscribeToEvents((e) => {
      setConnected(true);
      if (e.task_id === currentIdRef.current || !currentIdRef.current) {
        refreshCurrent(e.task_id);
        if (!currentIdRef.current) currentIdRef.current = e.task_id;
      }
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === e.task_id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], status: e.event === 'task_created' ? next[idx].status : next[idx].status };
        return next;
      });
      // authoritative reload for list-level changes (debounced by event nature)
      if (['task_created', 'task_completed', 'task_failed', 'task_cancelled'].includes(e.event)) refreshAll();
    });
    const onVis = () => { if (document.visibilityState === 'visible') { refreshAll(); JarvisClient.health().then(setHealth).catch(() => {}); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; unsub(); document.removeEventListener('visibilitychange', onVis); };
  }, [handshaken, refreshAll, refreshCurrent]);

  const createTask = useCallback(async (request: string, project?: string) => {
    setBusy(true);
    try {
      const t = await JarvisClient.createTask(request, project);
      currentIdRef.current = t.id;
      setCurrentTask(t);
      setEvents([]);
      await refreshAll();
      return t;
    } finally { setBusy(false); }
  }, [refreshAll]);

  const openTask = useCallback((id: string) => { currentIdRef.current = id; refreshCurrent(id); }, [refreshCurrent]);

  // Emergency stop (kill switch) + approvals
  const [emergencyStopped, setEmergencyStopped] = useState(false);
  const [approvals, setApprovals] = useState<import('../types').PendingApproval[]>([]);
  const refreshApprovals = useCallback(async () => {
    try {
      const list = await JarvisClient.listApprovals();
      setApprovals(list);
      setEmergencyStopped(list.length > 0 ? false : emergencyStopped);
    } catch { /* core offline */ }
  }, [emergencyStopped]);
  useEffect(() => {
    if (!handshaken) return;
    refreshApprovals();
    JarvisClient.getEmergencyStop().then((s) => setEmergencyStopped(s.stopped)).catch(() => {});
    const unsub = JarvisClient.subscribeToEvents((e) => {
      if (e.event.startsWith('approval.')) refreshApprovals();
    });
    return () => unsub();
  }, [handshaken, refreshApprovals]);

  const emergencyStop = useCallback(async () => {
    const r = await JarvisClient.emergencyStop();
    setEmergencyStopped(true);
    await refreshAll();
    return r;
  }, [refreshAll]);

  const clearEmergencyStop = useCallback(async () => {
    await JarvisClient.clearEmergencyStop();
    setEmergencyStopped(false);
  }, []);

  const retryCore = useCallback(() => {
    setCoreError(null);
    setHandshaken(false);
    setConnected(false);
    setRetryToken((t) => t + 1);
  }, []);

  const corePhase: CorePhase =
    coreError ? 'error'
    : !handshaken ? 'starting'
    : !connected ? 'connecting'
    : 'ready';

  return {
    currentTask, tasks, events, health, settings, connected, busy,
    corePhase, coreError, retryCore, coreReady: corePhase === 'ready',
    createTask, openTask, refreshAll, refreshCurrent, setSettings,
    openChatGPTLogin: () => { JarvisClient.openChatGPTLogin().catch(() => {}); },
    emergencyStop, clearEmergencyStop, emergencyStopped, approvals, refreshApprovals,
    decideApproval: async (id: string, approved: boolean) => { await JarvisClient.decideApproval(id, approved); await refreshApprovals(); },
    pause: (id: string) => JarvisClient.pauseTask(id).then((t) => setCurrentTask(t)).catch(() => {}),
    resume: async (id: string) => { await JarvisClient.resumeTask(id).catch((e) => { throw e; }); await refreshCurrent(id); },
    stop: (id: string) => JarvisClient.cancelTask(id).then((t) => setCurrentTask(t)).catch(() => {}),
  };
}
