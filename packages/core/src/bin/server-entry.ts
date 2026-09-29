/**
 * Standalone core server entry (bundled to a single file with esbuild).
 * The Tauri desktop shell spawns this as a sidecar (via dist-core/jarvis-core).
 * Prompts are embedded at build time (esbuild .md=text loader).
 * No CLI here — server only.
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { Orchestrator } from '../orchestrator.js';
import { JarvisServer } from '../server.js';
// prompts embedded by esbuild (loader: .md = text)
import plannerPromptTemplate from '../../../../prompts/chatgpt-planner.md';
import opencodeRules from '../../../../prompts/opencode-master.md';

const PORT = Number(process.env.JARVIS_PORT || 7788);

// a rejected background promise (task cleanup, browser close, session kill) must
// never take down the core — node would otherwise exit and orphan running tasks
process.on('unhandledRejection', (e) => console.error('[core] unhandledRejection (kept alive):', e));

// runtime dir: ~/.jarvis/runtime (writable even from a read-only DMG mount);
// JARVIS_RUNTIME_DIR overrides (dev uses the repo's runtime/)
const runtimeDir = process.env.JARVIS_RUNTIME_DIR || resolve(os.homedir(), '.jarvis', 'runtime');

async function main() {
  mkdirSync(runtimeDir, { recursive: true });

  const orchestrator = new Orchestrator({
    runtimeDir,
    plannerPromptTemplate: plannerPromptTemplate || DEFAULT_PLANNER,
    opencodeRules: opencodeRules || DEFAULT_OPENCODE_RULES,
    headless: process.env.JARVIS_HEADLESS === 'true',
  });
  const server = new JarvisServer(runtimeDir, orchestrator);
  const recovered = await server.recoverInterrupted();
  if (recovered.length) console.log(`recovery: marked ${recovered.length} interrupted task(s) PAUSED`);
  await server.listen(PORT, '127.0.0.1');
  console.log(`JARVIS core listening on http://127.0.0.1:${PORT}`);
}

const DEFAULT_PLANNER = `I am JARVIS, a local computer orchestrator.

My owner has requested:

{{OWNER_REQUEST}}

Act as a senior technical architect, product architect, security architect, QA engineer and DevOps architect.

Analyze the request thoroughly.

Return:
1. Clarified objective
2. Functional requirements
3. Non-functional requirements
4. Recommended architecture
5. Technology choices
6. Security requirements
7. Implementation phases
8. Testing strategy
9. Acceptance criteria
10. Risks
11. Failure/recovery considerations

Finally create:

=== OPENCODE MASTER PROMPT ===

The OpenCode prompt must instruct an autonomous coding agent to inspect the environment, implement the project phase-by-phase, test each phase and report structured progress.

Also append at the very end:

=== VERIFICATION SPEC ===
REQUIRED_FILES: <comma-separated list of files that must exist, relative to project dir>
TEST_COMMAND: <single shell command that must exit 0, or NONE>
HTTP_ENDPOINT: <URL that must return 2xx, or NONE>

Do not include or request private secrets.`;

const DEFAULT_OPENCODE_RULES = `1. Inspect existing files before modification.
2. Preserve valuable existing work.
3. Plan the minimum safe implementation.
4. Implement phase-by-phase.
5. Run relevant tests after each phase.
6. Review diffs before finishing.
7. Report actual failures honestly.
8. Never claim tests passed unless they ran.
9. Never expose secrets.
10. Do not perform destructive OS actions unrelated to the project.`;

main().catch((e) => {
  console.error('JARVIS core fatal:', e);
  process.exit(2);
});
