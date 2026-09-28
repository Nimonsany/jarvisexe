import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface OpenCodeSession {
  session_id: string;
  process: ChildProcess;
  output: string[];
  done: Promise<number>; // exit code
}

/**
 * Controls OpenCode via its CLI (`opencode run`). Sessions are "continued"
 * by sending follow-up prompts in the same project directory — OpenCode CLI
 * is stateless per invocation, so continuity = accumulated conversation file
 * we keep per task and prepend context to follow-up prompts.
 */
export class OpenCodeController {
  constructor(private bin = process.env.OPENCODE_BIN || 'opencode') {}

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
  }

  start(projectDir: string, prompt: string, onEvent: (line: string) => void): OpenCodeSession {
    const session_id = randomUUID();
    // --auto: non-interactive runs auto-reject external_directory permissions otherwise,
    // which breaks tasks in project dirs outside the opencode workspace.
    const proc = spawn(this.bin, ['run', '--auto', prompt], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return this.wrap(session_id, proc, onEvent);
  }

  /** Continue the same logical task: new opencode run in same project dir with corrective context. */
  continue(sessionId: string, projectDir: string, correctivePrompt: string, onEvent: (line: string) => void): OpenCodeSession {
    void sessionId; // continuity is preserved via the shared project directory
    return this.start(projectDir, correctivePrompt, onEvent);
  }

  stop(session: OpenCodeSession): void {
    if (!session.process.killed) session.process.kill('SIGTERM');
    setTimeout(() => { if (!session.process.killed) session.process.kill('SIGKILL'); }, 5000);
  }

  private wrap(session_id: string, proc: ChildProcess, onEvent: (line: string) => void): OpenCodeSession {
    const output: string[] = [];
    const handle = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        output.push(line);
        if (output.length > 5000) output.shift();
        onEvent(line);
      }
    };
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);
    const done = new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)));
    return { session_id, process: proc, output, done };
  }
}
