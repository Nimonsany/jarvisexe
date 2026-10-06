import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from './task/store.js';
import type { Task } from './task/types.js';
import { ChatGPTBrowser, defaultProfileDir } from './browser/chatgpt.js';
import { parsePlanResponse, parseCorrectiveResponse } from './browser/parser.js';
import { OpenCodeController } from './opencode/controller.js';
import { Supervisor, formatIncident } from './supervisor/supervisor.js';
import { sanitizeTruncated, sanitize } from './security/sanitize.js';
import { annotateInjections, scanForInjections } from './security/injection.js';
import { Verifier, type SoftwareVerificationSpec, type VerificationReport } from './verifier/verifier.js';
import { PHASE_BOT_ROUTING, type AgentBotProvider } from './agents/provider.js';
import type { ProcessRegistry } from './computer/registry.js';

export interface OrchestratorOptions {
  runtimeDir: string;
  plannerPromptTemplate: string;   // prompts/chatgpt-planner.md content
  opencodeRules: string;           // prompts/opencode-master.md content
  headless?: boolean;
}

const SPEC_RE = /===\s*VERIFICATION SPEC\s*===\s*([\s\S]*?)$/i;

function parseVerificationSpec(response: string): SoftwareVerificationSpec | null {
  const m = response.match(SPEC_RE);
  if (!m) return null;
  const spec: SoftwareVerificationSpec = {};
  for (const line of m[1].split('\n')) {
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    if (!v || v === 'NONE') continue;
    if (k.trim() === 'REQUIRED_FILES') spec.required_files = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (k.trim() === 'TEST_COMMAND') spec.test_command = v;
    if (k.trim() === 'HTTP_ENDPOINT') spec.http_endpoint = v;
  }
  return spec;
}

export class Orchestrator {
  private store: TaskStore;
  private chatgpt: ChatGPTBrowser;
  private opencode: OpenCodeController;
  private verifier = new Verifier();
  private activeSession: import('./opencode/controller.js').OpenCodeSession | null = null;
  private running = false;
  private cancelRequested = false;
  private pauseRequested = false;
  /** Per-task flag: true when pause occurred during WAITING_FOR_CHATGPT or PLANNING.
   * Keyed by taskId so one task never affects another. */
  private pausedDuringPlanning = new Map<string, boolean>();
  /** Planning attempt ID for this task. Responses from older attempts are ignored. */
  private planningAttemptId = new Map<string, number>();
  /** Set by the server: enables the post-verification reality-check bot review. */
  agentProvider: AgentBotProvider | null = null;

  /** M8 ownership: the shared process registry (set by the server). All
   *  task-spawned processes (opencode, verifier, browser tree) register here. */
  attachRegistry(r: ProcessRegistry): void {
    this.opencode.registry = r;
    this.chatgpt.registry = r;
    this.verifier.registry = r;
  }

  constructor(private opts: OrchestratorOptions) {
    this.store = new TaskStore(opts.runtimeDir);
    this.chatgpt = new ChatGPTBrowser(
      defaultProfileDir(opts.runtimeDir),
      opts.headless ?? false,
      process.env.JARVIS_BROWSER_CHANNEL || 'chrome',
    );
    this.opencode = new OpenCodeController();
  }

  get taskStore() { return this.store; }

  /** PAUSE: prevent new orchestration actions. The current OpenCode run finishes at the
   *  nearest safe checkpoint (loop boundary); state is persisted, sessions preserved. */
  async pause(taskId: string): Promise<Task> {
    const task = await this.store.load(taskId);
    if (['PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) return task;
    this.pausedDuringPlanning.set(taskId, task.status === 'WAITING_FOR_CHATGPT' || task.status === 'PLANNING');
    this.planningAttemptId.set(taskId, 0); // reset attempt ID on pause
    await this.store.transition(task, 'PAUSED');
    await this.store.emit(task, 'core', 'pause_requested', 'warning');
    return task;
  }

  /** Disk wins after every await: pause()/cancel() mutate a *different* in-memory
   *  copy, so the running loop's stale status would otherwise clobber PAUSED
   *  with a later transition/save (FR-9/10). True = caller must stop now. */
  private async diskWins(task: Task): Promise<boolean> {
    const live = await this.store.load(task.id).catch(() => null);
    if (live?.status === 'PAUSED' || live?.status === 'CANCELLED') {
      task.status = live.status; // adopt owner's state; disk already persisted
      return true;
    }
    return false;
  }

  /** RESUME: continue safely from persisted task state.
   *  In-flight loop (paused at a checkpoint): clear flags + set disk EXECUTING —
   *  the loop continues at its next checkpoint. Loop not in-flight: re-enter. */
  async resume(taskId: string): Promise<Task> {
    const task = await this.store.load(taskId);
    if (task.status !== 'PAUSED' && task.status !== 'WAITING_FOR_OWNER') return task;
    this.pauseRequested = false;
    this.cancelRequested = false;
    if (this.running) {
      await this.store.transition(task, 'EXECUTING').catch(() => {});
      await this.store.emit(task, 'core', 'task_resumed', 'info');
      return task;
    }
    const prevAttemptId = this.planningAttemptId.get(taskId) ?? 0;
    // planResponse declared at function scope; assigned in one of two branches below.
    let planResponse: string | null = null;

    if (this.pausedDuringPlanning.get(taskId)) {
      // --- BRANCH A: task was paused during WAITING_FOR_CHATGPT or PLANNING ---
      // Issue 2: do NOT wait 300s. Immediately re-initiate planning.
      // Issue 3: increment attempt ID so any stale response from a prior
      // attempt is ignored when it eventually arrives.
      const newAttemptId = (prevAttemptId || 0) + 1;
      this.planningAttemptId.set(taskId, newAttemptId);
      await this.store.emit(task, 'core', 'resume_replan_from_pause', 'info', { attemptId: newAttemptId });
      const freshPlan = await this.chatgpt.ask(
        this.opts.plannerPromptTemplate.replace('{{OWNER_REQUEST}}', task.owner_request)
      );
      const dir = this.store.taskDir(taskId);
      await writeFile(path.join(dir, 'chatgpt-plan.md'), freshPlan).catch(() => {});
      // Only accept the response if this attempt is still the current one
      if (this.planningAttemptId.get(taskId) === newAttemptId) {
        planResponse = freshPlan;
      }
    } else {
      // --- BRANCH B: task was NOT paused during planning (original behavior) ---
      // Issue 5: preserve the existing fallback path exactly.
      // Issue 2: the 300s wait is retained only for cases where planning was
      // NOT explicitly interrupted by Pause.
      try {
        const p = await readFile(path.join(this.store.taskDir(taskId), 'chatgpt-plan.md'), 'utf8');
        if (p.trim()) planResponse = p;
      } catch { /* not landed yet */ }
      if (!planResponse) {
        const deadline = Date.now() + 300_000;
        while (!planResponse && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3003));
          try {
            const p = await readFile(path.join(this.store.taskDir(taskId), 'chatgpt-plan.md'), 'utf8');
            if (p.trim()) planResponse = p;
          } catch { /* keep waiting */ }
        }
      }
      // Issue 4: verify attempt ID matches before proceeding
      if (this.planningAttemptId.get(taskId) !== prevAttemptId) {
        // a newer attempt already superseded this one; ignore response
        return task;
      }
    }
    // If planResponse is still null after both branches, something went wrong.
    if (!planResponse) {
      // This should not happen; fall through to the original CANCEL behaviour.
      task.last_error = 'resume: no plan response obtained';
      await this.store.save(task).catch(() => {});
      await this.store.transition(task, 'CANCELLED').catch(async () => { await this.store.save(task); });
      await this.store.emit(task, 'core', 'task_resume_aborted_no_plan', 'error');
      return task;
    }
    // Issue 4: double-check attempt ID after we have a plan response
    if (this.planningAttemptId.get(taskId) !== prevAttemptId) {
      await this.store.emit(task, 'core', 'planner_response_stale', 'warning', { attemptId: this.planningAttemptId.get(taskId) });
      return task;
    }
    // resume with the real objective (mirrors run()), never a vague
    // continue-prompt; re-parse the verification spec from the landed plan.
    let spec: SoftwareVerificationSpec | null = null;
    let firstPrompt = `Continue the task from its persisted state. Inspect existing files in the project directory, finish whatever remains, run the tests, and report the result honestly.`;
    try {
      const parsed = parsePlanResponse(planResponse);
      await writeFile(path.join(this.store.taskDir(taskId), 'opencode-prompt.md'), annotateInjections(parsed.opencodePrompt)).catch(() => {});
      firstPrompt = `${this.opts.opencodeRules}\n\n${parsed.opencodePrompt}`;
      spec = parseVerificationSpec(planResponse);
    } catch { /* fall back to empty spec */ }
    // Triple-check attempt ID after parsing — protect against race where
    // a stale response arrives after we've already started a new attempt.
    if (this.planningAttemptId.get(taskId) !== prevAttemptId) {
      await this.store.emit(task, 'core', 'planner_response_stale', 'warning', { attemptId: this.planningAttemptId.get(taskId) });
      return task;
    }
    await this.store.transition(task, 'EXECUTING');
    await this.store.emit(task, 'core', 'task_resumed', 'info');
    this.runLoopInBackground(task, firstPrompt, spec);
    return task;
  }

  /** STOP/CANCEL: kill controlled child work now, persist state, record in logs.
   *  The loop honours the flag at its next checkpoint (child ops that cannot be
   *  interrupted mid-command finish, then the task cancels). */
  async cancel(taskId: string): Promise<Task> {
    const task = await this.store.load(taskId);
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') return task;
    this.cancelRequested = true;
    if (this.activeSession) {
      this.opencode.stop(this.activeSession);
      this.activeSession = null;
      await this.store.emit(task, 'core', 'opencode_killed', 'warning');
    }
    await this.chatgpt.abort();
    await this.store.transition(task, 'CANCELLED').catch(async () => { await this.store.save(task); });
    await this.store.emit(task, 'core', 'task_cancelled', 'warning');
    return task;
  }

  /** Fire-and-forget loop runner used by resume(). */
  private runLoopInBackground(task: Task, prompt: string, spec: SoftwareVerificationSpec | null): void {
    this.running = true;
    this.executeLoop(task, prompt, spec)
      .catch(() => { /* task already marked FAILED inside run path */ })
      .finally(() => { this.running = false; this.activeSession = null; });
  }

  async run(ownerRequest: string, projectDir: string): Promise<Task> {
    if (!(await this.opencode.detect())) throw new Error('OpenCode CLI not found on PATH');
    this.cancelRequested = false; // fresh run: don't inherit a stale stop request
    this.pauseRequested = false;
    const task = await this.store.create(ownerRequest, projectDir);
    try {
      await this.chatgpt.launch();
      if (await this.diskWins(task)) return task; // paused/cancelled during launch

      // 1. PLANNING via ChatGPT browser
      await this.store.transition(task, 'PLANNING');
      await this.store.transition(task, 'WAITING_FOR_CHATGPT');
      const plannerPrompt = sanitize(this.opts.plannerPromptTemplate.replace('{{OWNER_REQUEST}}', ownerRequest));
      const planResponse = await this.chatgpt.ask(plannerPrompt);
      // pause/cancel may have landed while awaiting ChatGPT — the in-memory task
      // is stale; a transition/save below would clobber PAUSED (FR-9/10)
      if (await this.diskWins(task)) return task;
      const dir = this.store.taskDir(task.id);
      await writeFile(path.join(dir, 'chatgpt-plan.md'), planResponse);
      // prompt-injection defense: ChatGPT responses are untrusted data
      const planScan = scanForInjections(planResponse);
      if (!planScan.clean) {
        await this.store.emit(task, 'security', 'prompt_injection_flagged', 'warning', { source: 'chatgpt-plan', findings: planScan.findings.map((f) => f.label) });
      }
      const parsed = parsePlanResponse(planResponse);
      await writeFile(path.join(dir, 'opencode-prompt.md'), annotateInjections(parsed.opencodePrompt));
      await this.store.transition(task, 'PLAN_RECEIVED');
      await this.store.emit(task, 'planner', parsed.usedFallback ? 'fallback_prompt_generated' : 'master_prompt_extracted', 'info');

      // 2. EXECUTION loop with supervision
      const verificationSpec = parseVerificationSpec(planResponse);
      await this.executeLoop(task, `${this.opts.opencodeRules}\n\n${parsed.opencodePrompt}`, verificationSpec);
      return task;
    } catch (e) {
      task.last_error = String(e);
      if (await this.diskWins(task)) {
        // owner paused/cancelled mid-flight — keep THEIR state, record the error,
        // never overwrite PAUSED with FAILED (stale in-memory status would)
        await this.store.save(task);
        return task;
      }
      if (task.status === 'CANCELLED') {
        await this.store.save(task);
        return task; // cancelled: cancel() already logged it
      }
      if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status)) {
        await this.store.transition(task, 'FAILED').catch(() => {});
      }
      await this.store.save(task);
      await this.store.emit(task, 'core', 'task_failed', 'error', { error: task.last_error });
      throw e;
    } finally {
      await this.chatgpt.close();
    }
  }

  private async executeLoop(task: Task, prompt: string, verificationSpec: SoftwareVerificationSpec | null): Promise<void> {
    const supervisor = new Supervisor();
    const dir = this.store.taskDir(task.id);
    const dirConstraint = `\n\nCRITICAL CONSTRAINT: Work ONLY inside the project directory: ${task.project_directory}
Create/modify files there and run all commands with that as the working directory.
Do NOT modify, delete, or move anything outside that directory (especially not the JARVIS installation itself).`;
    let currentPrompt = prompt;

    for (;;) {
      // honour stop/pause requested while a child op was in flight
      if (this.cancelRequested) {
        await this.store.transition(task, 'CANCELLED').catch(() => {});
        await this.store.emit(task, 'core', 'task_cancelled', 'warning');
        return;
      }
      // consult authoritative disk state (pause/cancel may have arrived mid-ask)
      const disk = await this.store.load(task.id).catch(() => null);
      if (disk?.status === 'CANCELLED') {
        await this.store.emit(task, 'core', 'task_cancelled', 'warning');
        return;
      }
      if (disk?.status === 'PAUSED' && !this.pauseRequested) {
        // paused via API while this loop was awaiting something — wait for resume;
        // resume() flips disk to EXECUTING, detected on the next iteration
        await this.store.emit(task, 'core', 'paused_at_checkpoint', 'warning');
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (this.pauseRequested || task.status === 'PAUSED' || task.status === 'CANCELLED') {
        if (task.status !== 'PAUSED') await this.store.transition(task, 'PAUSED').catch(() => {});
        await this.store.emit(task, 'core', 'paused_at_checkpoint', 'warning');
        return;
      }
      if (task.status !== 'EXECUTING') {
        if (task.status === 'DEBUGGING') await this.store.transition(task, 'EXECUTING');
        else if (task.status !== 'PLAN_RECEIVED' && task.status !== 'PLANNING') { /* no-op */ }
        if (task.status === 'PLAN_RECEIVED') {
          await this.store.transition(task, 'PREPARING_EXECUTION');
          await this.store.transition(task, 'EXECUTING');
        }
      }

      await this.store.emit(task, 'opencode', 'session_start', 'info', { prompt_len: currentPrompt.length });
      const onEvent = (line: string) => console.log(`  [opencode] ${line.slice(0, 300)}`);
      const fullPrompt = currentPrompt + dirConstraint; // constraint on EVERY session
      let session = task.opencode_session
        ? this.opencode.continue(task.opencode_session, task.project_directory, fullPrompt, onEvent, task.id)
        : this.opencode.start(task.project_directory, fullPrompt, onEvent, task.id);
      task.opencode_session = session.session_id;
      this.activeSession = session;
      await this.store.save(task);

      const exitCode = await session.done;
      this.activeSession = null;

      // stop/pause may have been requested while the child ran — cancel now,
      // do NOT let the loop continue and overwrite the cancellation.
      if (this.cancelRequested) {
        await this.store.emit(task, 'opencode', 'session_exit', 'warning', { exitCode, cancelled: true });
        await this.store.transition(task, 'CANCELLED').catch(() => {});
        await this.store.emit(task, 'core', 'task_cancelled', 'warning');
        return;
      }
      if (this.pauseRequested) {
        await this.store.emit(task, 'opencode', 'session_exit', 'warning', { exitCode, paused: true });
        await this.store.transition(task, 'PAUSED').catch(() => {});
        await this.store.emit(task, 'core', 'paused_at_checkpoint', 'warning');
        return;
      }
      await this.store.emit(task, 'opencode', 'session_exit', exitCode === 0 ? 'info' : 'warning', { exitCode });
      await writeFile(path.join(dir, `opencode-run-${Date.now()}.log`), sanitize(session.output.join('\n')));

      await this.store.transition(task, 'MONITORING');
      const verdict = supervisor.decide(task, session.output, exitCode);

      if (verdict.kind === 'ok') {
        await this.store.transition(task, 'TESTING');
        await this.store.transition(task, 'VERIFYING');
        const spec = verificationSpec ?? { required_files: [] as string[] };
        const report = await this.verifier.verifySoftware(task, spec);
        await writeFile(path.join(dir, 'verification.json'), JSON.stringify(report, null, 2));
        task.verification_status = report.passed ? 'PASSED' : 'FAILED';
        await this.store.save(task);
        if (report.passed) {
          task.result = 'Verified: ' + report.steps.map((s) => `✔ ${s.name}`).join('; ');
          await this.store.transition(task, 'COMPLETED');
          await this.store.emit(task, 'verifier', 'task_completed', 'info');
          await this.reviewWithBot(task, report, dir);
          return;
        }
        // verification failed → treat as failure, feed into correction loop
        const failedSteps = 'VERIFICATION FAILED: ' + report.steps.filter((s) => !s.ok).map((s) => `${s.name} (${s.detail.slice(0, 200)})`).join(', ');
        session.output.push(failedSteps);
        const v2 = supervisor.decide(task, ['error verification failed'], 1);
        if (v2.kind === 'self_repair') {
          currentPrompt = `The previous implementation failed verification: ${failedSteps}\nApply the minimal fix and re-run the tests.`;
          task.retry_count++;
          await this.store.transition(task, 'DEBUGGING');
          continue;
        }
        if (v2.kind === 'give_up') {
          task.last_error = v2.reason;
          await this.store.save(task);
          await this.store.transition(task, 'DEBUGGING');
          await this.store.transition(task, 'WAITING_FOR_OWNER');
          return;
        }
        await this.consultChatGPT(task, {
          original_task: task.owner_request,
          current_phase: task.current_phase,
          expected: 'all verification steps pass: ' + report.steps.map((s) => s.name).join(', '),
          actual: failedSteps,
          error: failedSteps.slice(0, 500),
          logs_tail: session.output.slice(-60),
          attempts: task.retry_count,
        }).then(async (corrective) => { currentPrompt = corrective; });
        continue;
      }

      if (verdict.kind === 'self_repair') {
        task.retry_count++;
        await this.store.emit(task, 'supervisor', 'self_repair_attempt', 'warning', { attempt: task.retry_count, reason: verdict.reason });
        currentPrompt = `The previous run failed. Diagnose the error above in your earlier output, apply the minimal fix, re-run tests, and report the result honestly.`;
        await this.store.transition(task, 'DEBUGGING');
        continue;
      }

      if (verdict.kind === 'give_up') {
        task.last_error = verdict.reason;
        await this.store.save(task);
        await this.store.transition(task, 'DEBUGGING');
        await this.store.transition(task, 'WAITING_FOR_OWNER');
        await this.store.emit(task, 'supervisor', 'escalated_to_owner', 'error', { reason: verdict.reason });
        return;
      }

      // consult_chatgpt
      currentPrompt = await this.consultChatGPT(task, verdict.incident);
    }
  }

  /** Advisory reality-check: one bounded bot task after verification passes.
   *  Never fails the task and never throws — disabled via JARVIS_BOT_REVIEW=off. */
  private async reviewWithBot(task: Task, report: VerificationReport, dir: string): Promise<void> {
    if (!this.agentProvider || process.env.JARVIS_BOT_REVIEW === 'off') return;
    const botId = PHASE_BOT_ROUTING['final-verification'] ?? 'testing/reality-checker';
    const bot = this.agentProvider.getBot(botId);
    if (!bot) { await this.store.emit(task, 'computer', 'bot.review_skipped', 'warning', { bot: botId, reason: 'bot missing' }).catch(() => {}); return; }
    try {
      const context = [
        `Owner request: ${task.owner_request.slice(0, 800)}`,
        `Verification: ${report.steps.map((s) => `${s.name}=${s.ok ? 'pass' : 'fail'}`).join('; ')}`,
        `Claim: ${task.result ?? 'task completed'}`,
      ].join('\n');
      const r = await this.agentProvider.runBotTask(
        bot, task.id, 'final-verification',
        'Adversarial reality check of this completed task: is the claim credible? List any unverified assumptions.',
        sanitize(context), 420_000, // 420s: opencode boot + turns under thrash measured >300s (T6 allows 480)
      );
      await writeFile(path.join(dir, 'bot-review.json'), JSON.stringify({ bot: botId, ok: r.ok, analysis: r.analysis }, null, 2));
      await this.store.emit(task, 'computer', r.ok ? 'bot.review_completed' : 'bot.review_skipped', r.ok ? 'info' : 'warning',
        r.ok ? { bot: botId, chars: r.analysis.length } : { bot: botId, reason: 'bot run not ok', tail: r.analysis.slice(-300) }).catch(() => {});
    } catch (e) {
      await this.store.emit(task, 'computer', 'bot.review_skipped', 'warning', { bot: botId, reason: String(e).slice(0, 200) }).catch(() => {});
    }
  }

  /** Sanitize incident → ChatGPT browser → corrective prompt. Transitions handled here. */
  private async consultChatGPT(task: Task, incident: import('./supervisor/supervisor.js').IncidentPackage): Promise<string> {
    const dir = this.store.taskDir(task.id);
    task.chatgpt_cycle_count++;
    if (task.status !== 'DEBUGGING' && task.status !== 'MONITORING' && task.status !== 'EXECUTING') { /* tolerate */ }
    if (task.status !== 'DEBUGGING') await this.store.transition(task, 'DEBUGGING');
    await this.store.transition(task, 'WAITING_FOR_CHATGPT');
    const incidentText = sanitizeTruncated(formatIncident(incident));
    await this.store.emit(task, 'planner', 'consulting_chatgpt_for_debug', 'warning', { cycle: task.chatgpt_cycle_count });
    const debugResponse = await this.chatgpt.ask(incidentText);
    await writeFile(path.join(dir, `chatgpt-debug-${task.chatgpt_cycle_count}.md`), debugResponse);
    const debugScan = scanForInjections(debugResponse);
    if (!debugScan.clean) {
      await this.store.emit(task, 'security', 'prompt_injection_flagged', 'warning', { source: 'chatgpt-debug', findings: debugScan.findings.map((f) => f.label) });
    }
    await this.store.transition(task, 'PLAN_RECEIVED');
    return annotateInjections(parseCorrectiveResponse(debugResponse));
  }
}
