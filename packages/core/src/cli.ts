#!/usr/bin/env tsx
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import { TaskStore } from './task/store.js';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const runtimeDir = process.env.JARVIS_RUNTIME_DIR || resolve(repoRoot, 'runtime');

// background promise rejections (task cleanup etc.) must not kill a live server
process.on('unhandledRejection', (e) => console.error('[core] unhandledRejection (kept alive):', e));

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help') {
    console.log(`Usage:
  jarvis "<owner request>" [project-dir]   run a task end-to-end (foreground)
  jarvis serve                             start local API server (127.0.0.1:7788) for the desktop UI
  jarvis --resume                          list incomplete tasks
  jarvis --status TASK-ID                  show task status`);
    process.exit(0);
  }

  if (command === 'serve') {
    const { Orchestrator } = await import('./orchestrator.js');
    const { JarvisServer } = await import('./server.js');
    const plannerPromptTemplate = await readFile(resolve(repoRoot, 'prompts/chatgpt-planner.md'), 'utf8');
    const opencodeRules = await readFile(resolve(repoRoot, 'prompts/opencode-master.md'), 'utf8');
    const orchestrator = new Orchestrator({
      runtimeDir,
      plannerPromptTemplate,
      opencodeRules,
      headless: process.env.JARVIS_HEADLESS === 'true',
    });
    const server = new JarvisServer(runtimeDir, orchestrator);
    const recovered = await server.recoverInterrupted();
    if (recovered.length) console.log(`recovery: marked ${recovered.length} interrupted task(s) PAUSED — ${recovered.map((r) => `${r.id}(${r.from})`).join(', ')}`);
    await server.listen(Number(process.env.JARVIS_PORT || 7788), '127.0.0.1');
    console.log(`JARVIS core API listening on http://127.0.0.1:${process.env.JARVIS_PORT || 7788}`);
    console.log('Press Ctrl+C to stop.');
    return;
  }

  const store = new TaskStore(runtimeDir);

  if (command === 'voice') {
    // Milestone 5: wake word → STT → command → JARVIS Core → TTS
    const { VoiceLayer } = await import('./voice/voice.js');
    const { Orchestrator } = await import('./orchestrator.js');
    const plannerPromptTemplate = await readFile(resolve(repoRoot, 'prompts/chatgpt-planner.md'), 'utf8');
    const opencodeRules = await readFile(resolve(repoRoot, 'prompts/opencode-master.md'), 'utf8');
    const orchestrator = new Orchestrator({ runtimeDir, plannerPromptTemplate, opencodeRules, headless: process.env.JARVIS_HEADLESS === 'true' });
    const voice = new VoiceLayer();
    if (!voice.whisperReady()) return console.log('whisper-cli not found — brew install whisper-cpp');
    if (!voice.modelReady()) return console.log('whisper model not downloaded — run scripts/download-whisper-model.sh');
    const deviceArg = rest[0] ? Number(rest[0]) : undefined;
    const say = (m: string) => console.log(m);
    voice.startListenLoop(async (command) => {
      const { mkdirSync } = await import('node:fs');
      const projectDir = resolve(runtimeDir, '..', 'projects', `task-project-${Date.now()}`);
      mkdirSync(projectDir, { recursive: true });
      say(`→ submitting to JARVIS Core: "${command}"`);
      orchestrator.run(command, projectDir)
        .then((task) => {
          say(`✓ ${task.id} ${task.status}`);
          voice.speak(task.status === 'COMPLETED' ? `Task completed.` : `Task needs attention.`);
        })
        .catch(() => voice.speak('Task failed. Check the logs.'));
    }, deviceArg, say);
    return; // loop runs until Ctrl+C
  }

  if (command === '--resume') {
    const tasks = await store.listIncomplete();
    if (!tasks.length) return console.log('No incomplete tasks.');
    for (const t of tasks) console.log(`${t.id}  ${t.status}  ${t.owner_request}`);
    return;
  }

  if (command === '--status') {
    const t = await store.load(rest[0]);
    console.log(JSON.stringify(t, null, 2));
    return;
  }

  const ownerRequest = command;
  const projectDir = resolve(rest[0] || resolve(runtimeDir, '..', 'projects', `task-project-${Date.now()}`));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(projectDir, { recursive: true });

  // Resume protection
  const incomplete = await store.listIncomplete();
  if (incomplete.length) {
    console.log('An unfinished task was found:');
    for (const t of incomplete) console.log(`  ${t.id}  ${t.status}  ${t.owner_request}`);
    console.log('Proceeding with a new task; use --resume to list.');
  }

  const plannerPromptTemplate = await readFile(resolve(repoRoot, 'prompts/chatgpt-planner.md'), 'utf8');
  const opencodeRules = await readFile(resolve(repoRoot, 'prompts/opencode-master.md'), 'utf8');

  const orchestrator = new Orchestrator({
    runtimeDir,
    plannerPromptTemplate,
    opencodeRules,
    headless: process.env.JARVIS_HEADLESS === 'true',
  });

  const task = await orchestrator.run(ownerRequest, projectDir);
  console.log(`\n=== ${task.id} ${task.status} ===`);
  console.log(task.result ?? task.last_error ?? '');
  process.exit(task.status === 'COMPLETED' ? 0 : 1);
}

main().catch((e) => {
  console.error('JARVIS fatal:', e);
  process.exit(2);
});
