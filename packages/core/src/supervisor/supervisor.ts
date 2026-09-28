import type { Task } from '../task/types.js';

export type SupervisorVerdict =
  | { kind: 'ok' }
  | { kind: 'self_repair'; reason: string }
  | { kind: 'consult_chatgpt'; incident: IncidentPackage }
  | { kind: 'give_up'; reason: string };

export interface IncidentPackage {
  original_task: string;
  current_phase: string;
  expected: string;
  actual: string;
  error: string;
  logs_tail: string[];
  attempts: number;
}

const ERROR_HINTS = /\b(error|failed|failure|exception|traceback|cannot|not found|exit code [1-9]|assertion)\b/i;
const PROGRESS_HINTS = /\b(passed|success|done|created|installed|✓|ok)\b/i;

export const MAX_SELF_REPAIRS = 2;
export const MAX_CHATGPT_CYCLES = 3;

export class Supervisor {
  /** keyed by normalized error signature */
  private failureCounts = new Map<string, number>();

  static failureSignature(lines: string[]): string {
    const errLine = lines.find((l) => ERROR_HINTS.test(l)) ?? 'unknown';
    return errLine.replace(/\d+/g, '#').slice(0, 120).toLowerCase();
  }

  static outputHasFailure(lines: string[], exitCode = 0): boolean {
    if (exitCode !== 0) return true;
    // Only the very end of the output reflects the final outcome — earlier
    // lines legitimately mention past errors ("One failure was hit and fixed").
    const tail = lines.slice(-15).join('\n');
    if (
      /all .*tests? (pass|passed)|passed,\s*0 failed|\b\d+(?:\/\d+)?\s*(?:tests?\s*)?(pass|passed)\b|\bpass(ed)?\b.*\b0 failed\b/i.test(tail)
    ) return false;
    // Hard error artifacts only: bare words like "error"/"failure" appear in
    // conversational meta-talk ("there is no error to diagnose") and must NOT
    // trigger repair loops.
    return /error:|error ts\d+|error \d|npm err|traceback|exit code [1-9]|assertion\s*failed|assertionerror|command not found|permission denied|no such file|\b\d+\s+failed\b|tests? failed|\bfailed:|auto-rejecting|segmentation fault|✗/i.test(tail)
      || /\bFAILED\b/.test(tail);
  }

  /**
   * Decide next step after an OpenCode run finishes with failure output.
   */
  decide(task: Task, outputLines: string[], exitCode: number): SupervisorVerdict {
    const failed = Supervisor.outputHasFailure(outputLines, exitCode);
    if (!failed) return { kind: 'ok' };

    const sig = Supervisor.failureSignature(outputLines);
    const count = (this.failureCounts.get(sig) ?? 0) + 1;
    this.failureCounts.set(sig, count);

    if (count <= MAX_SELF_REPAIRS) {
      return { kind: 'self_repair', reason: `failure signature seen ${count}x: ${sig}` };
    }
    if (task.chatgpt_cycle_count >= MAX_CHATGPT_CYCLES) {
      return { kind: 'give_up', reason: `same failure persists after ${count} attempts and ${task.chatgpt_cycle_count} ChatGPT cycles` };
    }
    return {
      kind: 'consult_chatgpt',
      incident: {
        original_task: task.owner_request,
        current_phase: task.current_phase,
        expected: 'the step completes without errors and tests pass',
        actual: 'execution failed',
        error: sig,
        logs_tail: outputLines.slice(-60),
        attempts: count,
      },
    };
  }

  reset() { this.failureCounts.clear(); }
}

export function formatIncident(p: IncidentPackage): string {
  return `ORIGINAL TASK:\n${p.original_task}

CURRENT PHASE:\n${p.current_phase}

EXPECTED RESULT:\n${p.expected}

ACTUAL RESULT:\n${p.actual}

ERROR:\n${p.error}

RELEVANT LOGS (tail):
${p.logs_tail.join('\n')}

ATTEMPTS ALREADY MADE: ${p.attempts}

QUESTION:
Identify: 1) likely root cause 2) what should be inspected 3) safest fix 4) tests required 5) regression risks.
Finally return:
=== OPENCODE CORRECTIVE PROMPT ===
...`;
}
