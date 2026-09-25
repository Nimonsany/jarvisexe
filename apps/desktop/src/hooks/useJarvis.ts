import { useCallback, useEffect, useRef, useState } from 'react';
import { JarvisClient } from '../services/JarvisClient';
import type { Task, TaskEvent, Health, Settings } from '../types';

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
    } catch {
      setConnected(false);
    }
  }, [refreshCurrent]);

  useEffect(() => {
    JarvisClient.health().then(setHealth).catch(() => setHealth(null));
    JarvisClient.getSettings().then(setSettings).catch(() => {});
    refreshAll();
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
    return () => { unsub(); document.removeEventListener('visibilitychange', onVis); };
  }, [refreshAll, refreshCurrent]);

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

  return {
    currentTask, tasks, events, health, settings, connected, busy,
    createTask, openTask, refreshAll, refreshCurrent, setSettings,
    openChatGPTLogin: () => { JarvisClient.openChatGPTLogin().catch(() => {}); },
    pause: (id: string) => JarvisClient.pauseTask(id).then((t) => setCurrentTask(t)).catch(() => {}),
    resume: async (id: string) => { await JarvisClient.resumeTask(id).catch((e) => { throw e; }); await refreshCurrent(id); },
    stop: (id: string) => JarvisClient.cancelTask(id).then((t) => setCurrentTask(t)).catch(() => {}),
  };
}
