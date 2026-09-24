import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TaskStore } from './task/store.js';
import type { Task } from './task/types.js';
import { ChatGPTBrowser, defaultProfileDir } from './browser/chatgpt.js';
import { parsePlanResponse, parseCorrectiveResponse } from './browser/parser.js';
import { OpenCodeController } from './opencode/controller.js';
import { Supervisor, formatIncident } from './supervisor/supervisor.js';
import { sanitizeTruncated, sanitize } from './security/sanitize.js';
import { Verifier, type SoftwareVerificationSpec } from './verifier/verifier.js';

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

  async run(ownerRequest: string, projectDir: string): Promise<Task> {
    if (!(await this.opencode.detect())) throw new Error('OpenCode CLI not found on PATH');
    const task = await this.store.create(ownerRequest, projectDir);
    try {
      await this.chatgpt.launch();

      // 1. PLANNING via ChatGPT browser
      await this.store.transition(task, 'PLANNING');
      await this.store.transition(task, 'WAITING_FOR_CHATGPT');
      const plannerPrompt = sanitize(this.opts.plannerPromptTemplate.replace('{{OWNER_REQUEST}}', ownerRequest));
      const planResponse = await this.chatgpt.ask(plannerPrompt);
      const dir = this.store.taskDir(task.id);
      await writeFile(path.join(dir, 'chatgpt-plan.md'), planResponse);
      const parsed = parsePlanResponse(planResponse);
      await writeFile(path.join(dir, 'opencode-prompt.md'), parsed.opencodePrompt);
      await this.store.transition(task, 'PLAN_RECEIVED');
      await this.store.emit(task, 'planner', parsed.usedFallback ? 'fallback_prompt_generated' : 'master_prompt_extracted', 'info');

      // 2. EXECUTION loop with supervision
      const verificationSpec = parseVerificationSpec(planResponse);
      const dirConstraint = `\n\nCRITICAL CONSTRAINT: Work ONLY inside the project directory: ${task.project_directory}
Create/modify files there and run all commands with that as the working directory.
Do NOT modify, delete, or move anything outside that directory (especially not the JARVIS installation itself).`;
      await this.executeLoop(task, `${this.opts.opencodeRules}\n\n${parsed.opencodePrompt}${dirConstraint}`, verificationSpec);
      return task;
    } catch (e) {
      task.last_error = String(e);
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
    let currentPrompt = prompt;

    for (;;) {
      if (task.status === 'PAUSED' || task.status === 'CANCELLED') return;
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
      let session = task.opencode_session
        ? this.opencode.continue(task.opencode_session, task.project_directory, currentPrompt, onEvent)
        : this.opencode.start(task.project_directory, currentPrompt, onEvent);
      task.opencode_session = session.session_id;
      await this.store.save(task);

      const exitCode = await session.done;
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
    await this.store.transition(task, 'PLAN_RECEIVED');
    return parseCorrectiveResponse(debugResponse);
  }
}
