import { JarvisServer } from '../../packages/core/src/server.js';
import { TaskStore } from '../../packages/core/src/task/store.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const store = new TaskStore('/tmp/jarvis-repro2');
const fake = {
  taskStore: store,
  run: async (req: string, dir: string): Promise<Task> => {
    const t = await store.create(req, dir);
    await store.transition(t, 'PLANNING');
    return t;
  },
  pause: async (i: string) => store.load(i), resume: async (i: string) => store.load(i), cancel: async (i: string) => store.load(i),
};
import type { Task } from '../../packages/core/src/task/types.js';
const s = new JarvisServer('/tmp/jarvis-repro2', fake as never);
await s.listen(7791, '127.0.0.1');
console.log('1: opening SSE...');
const controller = new AbortController();
const stream = await fetch('http://127.0.0.1:7791/api/events', { signal: controller.signal });
console.log('2: SSE headers:', stream.headers.get('content-type'));
const reader = stream.body!.getReader();
console.log('3: creating task...');
const t = await (await fetch('http://127.0.0.1:7791/api/task', { method: 'POST', body: JSON.stringify({ request: 'sse' }), headers: { 'Content-Type': 'application/json' } })).json();
console.log('4: task created', t.id);
const { value } = await Promise.race([reader.read(), sleep(5000).then(() => ({ value: undefined }))]);
console.log('5: first SSE chunk:', value ? new TextDecoder().decode(value).slice(0, 80) : 'TIMEOUT');
controller.abort();
await reader.cancel().catch(() => {});
await s.close();
process.exit(0);
