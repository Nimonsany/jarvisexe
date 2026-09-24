# JARVIS Architecture

JARVIS is a **local-first autonomous orchestrator**. It is not an LLM.

```
OWNER
  │ (text/voice, later UI)
  ▼
JARVIS Core (CLI in Milestone 1, Tauri UI in Milestone 2)
  │
  ├── Planner        → ChatGPT via real browser (Playwright, NO OpenAI API)
  ├── Executor       → OpenCode via local CLI (spawn child process)
  ├── Supervisor     → watches executor, detects failure, drives correction loop
  ├── Verifier       → independently checks the real-world result
  ├── SecurityPolicy → sanitizes anything sent to ChatGPT; permission levels
  └── TaskStore      → JSONL events + status.json per task, crash-safe
```

## Correction loop

```
OpenCode → failure → Supervisor → Incident Package → Sanitizer
  → ChatGPT (browser) → corrective prompt → same OpenCode session → retest
```

- 2 local self-repair attempts, then ChatGPT consultation.
- Max 3 ChatGPT correction cycles, then WAITING_FOR_OWNER.

## Components are adapters

- `Planner` interface: today ChatGPTBrowserController; swappable.
- `Executor` interface: today OpenCodeController; swappable.
- `Verifier` interface: per-task-type verifiers (software, file, browser).

## State

- Task states: NEW, PLANNING, WAITING_FOR_CHATGPT, PLAN_RECEIVED,
  EXECUTING, MONITORING, TESTING, VERIFYING, DEBUGGING,
  WAITING_FOR_OWNER, PAUSED, FAILED, COMPLETED, CANCELLED.
- Each task persists to `runtime/tasks/<TASK_ID>/` — a crash never loses it.

## Security (Milestone 1 baseline)

- Dedicated browser profile at `runtime/browser-profile/` — never committed.
- All content going to ChatGPT passes through the sanitizer (`[REDACTED_SECRET]`).
- External content (browser, OpenCode output) is untrusted data, never instructions.
- No root/admin execution. No destructive shell commands issued by JARVIS itself.

## Later milestones (not built yet)

Tauri UI, ComputerController, voice, local dashboard, MCP plugins, packaging, signed updates.
