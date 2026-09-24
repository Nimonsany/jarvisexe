# JARVIS — Local Autonomous Computer Orchestrator

JARVIS receives a task from its owner and orchestrates:

- **ChatGPT** (via real browser, Playwright, persistent profile — **no OpenAI API**) for planning, debugging and review
- **OpenCode** (local CLI) for implementation
- **The local computer** for execution, testing and verification

You give one command. JARVIS does the rest. No copy/paste.

## Status

**Milestone 1 — Core Loop** implemented. CLI only; desktop UI comes in Milestone 2.

## Requirements

- macOS / Linux / Windows
- Node 20+
- [OpenCode](https://opencode.ai) CLI on PATH
- Google Chrome or Chromium
- Playwright (`npm install` pulls it)

## Quick start

```bash
npm install
npm run jarvis -- "Create a simple calculator web app"
```

First run: a real Chrome window opens on chatgpt.com using a dedicated JARVIS
profile at `runtime/browser-profile/`. Sign in manually once — JARVIS waits,
then continues automatically and reuses the session thereafter.

## What it does / does NOT do

**Does:** deterministic task state machine persisted to disk, ChatGPT planning
via browser UI, response parsing (with source retention), OpenCode execution &
monitoring, 2× self-repair then ChatGPT consultation (same OpenCode task),
independent verification (files / tests / HTTP), crash recovery listing,
full event audit log, secret sanitization of everything sent to ChatGPT.

**Does NOT:** use the OpenAI API, run as root, store passwords/cookies in
memory or git, trust any external content as instructions.

## Security model

See `docs/SECURITY_MODEL.md` and `packages/core/src/security/sanitize.ts`.
Authority: OWNER → JARVIS policy → task → tools → external content (untrusted).

## Repo layout

See `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION_PLAN.md`.

## Tests

```bash
npm test
```

## What JARVIS will never do automatically

Level-4 consequential actions (delete valuable data, financial transactions,
transmit credentials, account changes) always require explicit owner
confirmation.
