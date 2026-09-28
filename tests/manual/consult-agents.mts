/**
 * Consult ChatGPT (via the JARVIS browser controller) to verify + improvise the
 * multi-agent roster for JARVIS's orchestration use case.
 * Run: npx tsx tests/manual/consult-agents.mts  (no server needed — direct controller)
 */
import { ChatGPTBrowser, defaultProfileDir } from '../../packages/core/src/browser/chatgpt.js';
import { writeFile, mkdirSync } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdirSync as mkdirSyncSync } from 'node:fs';

const roster = readFileSync('/tmp/roster.json', 'utf8');
const browser = new ChatGPTBrowser(defaultProfileDir('runtime'), false, 'chrome');
await browser.launch();

const prompt = `I am JARVIS, a local autonomous computer orchestrator (already working: ChatGPT browser planning → OpenCode coding → supervisor → verification, with security policy and voice).

I have a roster of specialist agent personas (279 agents, 22 divisions) in markdown files with frontmatter (name, description, vibe). My orchestrator will route each task/phase to a matching specialist bot; each bot handles ONE task at a time, and Context7 (docs MCP) queries go through a shared load-balancer.

Current divisions and sample agents:
${roster.slice(0, 4500)}

QUESTION — answer concisely:
1. For an AUTONOMOUS SOFTWARE-ORCHESTRATION pipeline (analyze → plan → implement → test → verify → review → document → package), which of my existing agent personas are the RIGHT specialists per phase? Pick ~8-12 specific agents (division + agent slug).
2. What NEW agent personas are missing for this pipeline in 2026 (improvise with the latest agentic-AI landscape)? Suggest ~5-8 with name + one-line mission + division.
3. How should Context7 (docs MCP) load-balancing work across multiple agent bots for efficiency? (dedupe, caching, rate limits — concrete scheme)
4. Any risks in running many specialist bots, each on one task?

Keep the total answer under 600 words.`;

const t0 = Date.now();
const res = await browser.ask(prompt, 600_000);
console.log('elapsed_s:', Math.round((Date.now() - t0) / 1000));
mkdirSyncSync('runtime/consults', { recursive: true });
await writeFile('runtime/consults/agent-roster-consult.md', res);
console.log('---RESPONSE---');
console.log(res.slice(0, 3500));
await browser.close();
process.exit(0);
