import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TaskStore } from './task/store.js';
import type { Task, TaskEvent } from './task/types.js';
import { sanitize } from './security/sanitize.js';
import { ChatGPTBrowser, defaultProfileDir } from './browser/chatgpt.js';
import type { Orchestrator } from './orchestrator.js';

export interface JarvisSettings {
  defaultProjectDir: string;
  opencodeBin: string;
  browserChannel: string;      // 'chrome' | 'chromium'
  headless: boolean;           // visible browser mode by default
  autoConsultThreshold: number;
  maxRetries: number;
  finalReview: boolean;        // not wired yet (later milestone)
  startMinimized: boolean;     // not wired yet (later milestone)
  theme: 'dark' | 'light';
  logVerbosity: 'quiet' | 'normal' | 'verbose';
}

const DEFAULT_SETTINGS: JarvisSettings = {
  defaultProjectDir: '',
  opencodeBin: 'opencode',
  browserChannel: 'chrome',
  headless: false,
  autoConsultThreshold: 2,
  maxRetries: 3,
  finalReview: false,
  startMinimized: false,
  theme: 'dark',
  logVerbosity: 'normal',
};

export interface Health {
  core: 'online';
  opencode: 'ready' | 'missing';
  chatgptProfile: 'ready' | 'missing';
  chatgptLogin: 'ok' | 'required' | 'unknown' | 'checking';
  storage: 'ready' | 'error';
}

export class JarvisServer {
  private store: TaskStore;
  private settings: JarvisSettings;
  private loginWatcher: ChatGPTBrowser | null = null;
  private loginState: Health['chatgptLogin'] = 'unknown';
  private busy = false;

  constructor(private runtimeDir: string, private orchestrator: Orchestrator, settings?: Partial<JarvisSettings>) {
    this.store = orchestrator.taskStore;
    mkdirSync(runtimeDir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    // apply operational settings the core uses
    process.env.OPENCODE_BIN = this.settings.opencodeBin;
    process.env.JARVIS_BROWSER_CHANNEL = this.settings.browserChannel;
    this.store.bus.on('event', () => { /* SSE clients read via /api/events */ });
  }

  private settingsPath() { return path.join(this.runtimeDir, 'settings.json'); }

  async getSettings(): Promise<JarvisSettings> {
    try {
      const raw = await readFile(this.settingsPath(), 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { return this.settings; }
  }

  async updateSettings(patch: Partial<JarvisSettings>): Promise<JarvisSettings> {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    // validate paths that must exist if provided
    if (next.defaultProjectDir && !existsSync(next.defaultProjectDir)) {
      throw new Error(`defaultProjectDir does not exist: ${next.defaultProjectDir}`);
    }
    await writeFile(this.settingsPath(), JSON.stringify(next, null, 2));
    this.settings = next;
    process.env.OPENCODE_BIN = next.opencodeBin;
    process.env.JARVIS_BROWSER_CHANNEL = next.browserChannel;
    return next;
  }

  async health(): Promise<Health> {
    const opencode = await this.orchestrator.taskStore && existsSync('/dev/null')
      ? await this.checkOpencode() : 'missing';
    return {
      core: 'online',
      opencode,
      chatgptProfile: existsSync(defaultProfileDir(this.runtimeDir)) ? 'ready' : 'missing',
      chatgptLogin: this.loginState,
      storage: existsSync(this.runtimeDir) ? 'ready' : 'error',
    };
  }

  private checkOpencode(): Promise<Health['opencode']> {
    return new Promise((resolve) => {
      const p = spawn(this.settings.opencodeBin, ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve('missing'));
      p.on('exit', (code) => resolve(code === 0 ? 'ready' : 'missing'));
    });
  }

  async createTask(request: string, project?: string): Promise<Task> {
    if (this.busy) throw new Error('A task is already running');
    this.busy = true;
    const dir = project || this.settings.defaultProjectDir || path.join(this.runtimeDir, '..', 'projects', `task-project-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // run in background; UI follows via SSE
    this.orchestrator.run(request, dir)
      .catch(() => {})
      .finally(() => { this.busy = false; });
    // wait briefly so the task id exists before returning
    for (let i = 0; i < 50; i++) {
      const tasks = await this.store.listAll();
      const match = tasks.find((t) => t.owner_request === request && Date.now() - new Date(t.created_at).getTime() < 15000);
      if (match) return match;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('task did not start');
  }

  /** Opens the dedicated browser for manual ChatGPT sign-in; updates loginState. */
  async openChatGPTLogin(): Promise<void> {
    if (this.loginWatcher) return;
    this.loginState = 'checking';
    this.loginWatcher = new ChatGPTBrowser(defaultProfileDir(this.runtimeDir), false, this.settings.browserChannel);
    const watcher = this.loginWatcher;
    (async () => {
      try {
        await watcher.launch();
        await watcher.ensureLoggedIn(() => { if (this.loginState !== 'ok') this.loginState = 'required'; });
        this.loginState = 'ok';
      } catch {
        this.loginState = 'unknown';
      } finally {
        await watcher.close().catch(() => {});
        this.loginWatcher = null;
      }
    })();
  }

  async listProjects(): Promise<{ path: string; latestTask?: string; status?: string }[]> {
    const tasks = await this.store.listAll();
    const map = new Map<string, { path: string; latestTask?: string; status?: string }>();
    for (const t of tasks) {
      if (!map.has(t.project_directory)) map.set(t.project_directory, { path: t.project_directory, latestTask: t.id, status: t.status });
    }
    return [...map.values()];
  }

  openProject(dir: string): void {
    if (!existsSync(dir)) throw new Error(`not found: ${dir}`);
    spawn('open', [dir], { stdio: 'ignore' }); // macOS
  }

  private sanitizeEvent(e: TaskEvent): TaskEvent {
    return JSON.parse(sanitize(JSON.stringify(e)));
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    void this.handleAsync(req, res);
  }

  private async handleAsync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(data));
    };
    let body: Record<string, unknown> = {};
    try {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      }

      if (req.method === 'GET' && p === '/api/health') return void json(await this.health());
      if (req.method === 'GET' && p === '/api/tasks') return void json(await this.store.listAll());
      if (req.method === 'GET' && p === '/api/settings') return void json(await this.getSettings());
      if (req.method === 'POST' && p === '/api/settings') return void json(await this.updateSettings(body as Partial<JarvisSettings>));
      if (req.method === 'GET' && p === '/api/projects') return void json(await this.listProjects());
      if (req.method === 'POST' && p === '/api/task') {
        return void json(await this.createTask(String(body.request ?? ''), body.project ? String(body.project) : undefined));
      }
      if (req.method === 'POST' && p === '/api/project/open') { this.openProject(String(body.path ?? '')); return void json({ ok: true }); }
      if (req.method === 'POST' && p === '/api/chatgpt/login') { await this.openChatGPTLogin(); return void json({ ok: true }); }

      const taskMatch = p.match(/^\/api\/task\/([^/]+)(\/(pause|resume|cancel))?$/);
      if (taskMatch) {
        const id = taskMatch[1];
        const action = taskMatch[3];
        if (req.method === 'GET' && !action) {
          const task = JSON.parse(sanitize(JSON.stringify(await this.store.load(id))));
          const events = (await this.store.events(id)).map((e) => this.sanitizeEvent(e));
          return void json({ task, events });
        }
        if (req.method === 'POST' && action === 'pause') return void json(await this.orchestrator.pause(id));
        if (req.method === 'POST' && action === 'resume') return void json(await this.orchestrator.resume(id));
        if (req.method === 'POST' && action === 'cancel') return void json(await this.orchestrator.cancel(id));
      }

      if (req.method === 'GET' && p === '/api/events') {
        // SSE: live task events
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors });
        res.flushHeaders(); // send headers immediately so fetch()/EventSource resolve
        const onEvent = (e: TaskEvent) => { try { res.write(`data: ${JSON.stringify(this.sanitizeEvent(e))}\n\n`); } catch { /* client gone */ } };
        this.store.bus.on('event', onEvent);
        req.on('close', () => this.store.bus.off('event', onEvent));
        return;
      }

      json({ error: 'not found' }, 404);
    } catch (e) {
      if (!res.headersSent) json({ error: String(e) }, 500);
      else { try { res.end(JSON.stringify({ error: String(e) })); } catch { /* already closed */ } }
    }
  }

  private httpServer: http.Server | null = null;

  listen(port = 7788, host = '127.0.0.1'): Promise<void> {
    const srv = http.createServer((req, res) => this.handle(req, res));
    this.httpServer = srv;
    return new Promise((resolve) => srv.listen(port, host, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer?.close(() => resolve());
      this.httpServer?.closeAllConnections(); // SSE/keep-alive connections must not block shutdown
    });
  }
}
