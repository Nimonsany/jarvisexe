# Implementation Plan

## Milestone 1 — Core Loop (THIS MILESTONE)

Delivered as a TypeScript CLI: `npm run jarvis -- "Create a simple calculator web app"`

| # | Component | File | Status |
|---|-----------|------|--------|
| 1 | Task state machine + JSON persistence | `packages/core/src/task/*` | DONE |
| 2 | ChatGPT browser controller (Playwright, persistent profile) | `packages/core/src/browser/chatgpt.ts` | DONE |
| 3 | Response parser (PLAN / OPENCODE MASTER PROMPT / fallback) | `packages/core/src/browser/parser.ts` | DONE |
| 4 | OpenCode controller (CLI spawn, events, continue-session) | `packages/core/src/opencode/controller.ts` | DONE |
| 5 | Supervisor (failure detect, self-repair ×2, escalate) | `packages/core/src/supervisor/supervisor.ts` | DONE |
| 6 | Secret sanitizer | `packages/core/src/security/sanitize.ts` | DONE |
| 7 | Verifier (file existence, tests, HTTP endpoint, browser smoke) | `packages/core/src/verifier/verifier.ts` | DONE |
| 8 | Prompts (planner / debugger / reviewer) | `prompts/*.md` | DONE |
| 9 | Orchestrator (wires everything, state machine driver) | `packages/core/src/orchestrator.ts` | DONE |
| 10 | CLI entry point | `packages/core/src/cli.ts` | DONE |
| 11 | Unit tests (state machine, parser, sanitizer, supervisor) | `tests/*.test.ts` | DONE |
| 12 | E2E acceptance demo ("calculator web app") | manual run against live ChatGPT | **PASS — TASK-000006** |

## Milestone 2 — Desktop UI (DONE)

Tauri 2 + React + TypeScript desktop app in `apps/desktop/`, operating as a
presentation/control layer over JARVIS Core (no orchestration logic in React).

| # | Component | Where | Status |
|---|-----------|-------|--------|
| 1 | Core bridge: event bus + pause/resume/cancel | `packages/core/src/orchestrator.ts` | DONE |
| 2 | Local HTTP+SSE API server (127.0.0.1:7788, sanitized responses) | `packages/core/src/server.ts` | DONE |
| 3 | Settings store (validated, local) | `packages/core/src/server.ts` | DONE |
| 4 | JarvisClient (UI↔core adapter; SSE subscribe) | `apps/desktop/src/services/JarvisClient.ts` | DONE |
| 5 | Dashboard (input, pipeline, current task, activity, errors, health bar) | `apps/desktop/src/pages/Dashboard.tsx` | DONE |
| 6 | Tasks history + Task details | `apps/desktop/src/pages/Tasks.tsx`, `TaskDetail.tsx` | DONE |
| 7 | Projects / Settings / Logs pages | `apps/desktop/src/pages/*` | DONE |
| 8 | Dark theme, responsive, a11y (labels, focus, keyboard) | `apps/desktop/src/styles.css` | DONE |
| 9 | Original app icon (generated, not copyrighted) | `scripts/gen-icon.mts` → `apps/desktop/src-tauri/icons/` | DONE |
| 10 | Frontend tests (vitest + RTL) | `apps/desktop/tests/ui.test.tsx` | DONE 9/9 |
| 11 | IPC tests | `tests/server-e2e.mts` | DONE 8/8 |
| 12 | UI E2E: task entry → live status → calculator COMPLETED (TASK-000007) | `tests/manual/ui-e2e-stage1.mts` | PASS |
| 13 | UI E2E: restart test + STOP test (TASK-000009/10) | `tests/manual/ui-e2e-stage2.mts` | PASS |
| 14 | Tauri binary builds + launches (release) | `src-tauri/target/release/jarvis-desktop` | PASS |

Pause semantics: pause prevents new orchestration actions; the active
OpenCode/browser call finishes at its nearest safe checkpoint, then the task
transitions to PAUSED with sessions preserved. Resume continues from persisted
state. STOP kills the OpenCode child immediately and transitions to CANCELLED.

## Milestone 3+ — not started

Computer control, voice, dashboard remote access, MCP plugins, packaging.

## Acceptance criteria (Milestone 1)

One owner command → ChatGPT planning via browser → OpenCode execution →
automatic correction loop on failure → independent verification → COMPLETED.
No copy/paste. No OpenAI API.

## Milestone 3 — Computer Control (DONE)

Computer control as another TOOL PROVIDER under the same orchestration model.

| # | Component | Where | Status |
|---|-----------|-------|--------|
| 1 | ComputerController + adapters (terminal/filesystem/applications/clipboard/screen/keyboard/mouse) | `packages/core/src/computer/` | DONE |
| 2 | SecurityPolicy v1 (READ/SAFE_WRITE/EXECUTE/UI_AUTOMATION/DESTRUCTIVE, project scope, secret protection, STOP/PAUSE hooks) | `packages/core/src/computer/policy.ts` | DONE |
| 3 | Process ownership registry (STOP kills only controlled children) | `packages/core/src/computer/registry.ts` | DONE |
| 4 | Audit log (append-only, sanitized) | `runtime/audit.jsonl` | DONE |
| 5 | Gate A: per-install auth token + strict origin allowlist + SSE auth | `packages/core/src/server.ts` | DONE (tested) |
| 6 | Gate B: real Pause/Resume E2E (found + fixed empty-spec verification bug) | `tests/manual/gate-b-pause-resume.mts` | PASS (mechanics) |
| 7 | Gate C: health caching (avg 116ms during browser launch) | `packages/core/src/server.ts` | PASS |
| 8 | E2E A (filesystem), B (app launch), C (node script) | `tests/manual/m3-e2e-abc.mts` | ALL PASS |
| 9 | E2E D (human behavior DOM loop), E (STOP), F (PAUSE), G (prompt injection) | `tests/manual/m3-e2e-defg.mts` | ALL PASS |
| 10 | LOCAL API SECURITY acceptance (untrusted origins/tokens rejected) | `tests/manual/m3-e2e-defg.mts` | ALL PASS |
| 11 | M3 unit tests (terminal/fs/policy/sanitizer/registry) | `tests/computer.test.mts` | 15/15 |
| 12 | UI: authenticated JarvisClient (bootstrap token) + Computer Activity section | `apps/desktop/src/` | DONE (M3 UI E2E PASS) |

### Security model (M3)

- Local API: origin allowlist (JARVIS UI only) + per-install token for all
  state-changing requests + SSE `?token=` (EventSource limitation, documented).
- Every computer action: SecurityPolicy.authorize() → execute → structured
  result → event → audit. DESTRUCTIVE requires explicit ownerConfirmed.
- Secret locations (~/.ssh, .env, keychains, browser profiles) never touched
  without explicit justification; external content is never instruction.

### Platform status

- macOS: **Implemented + Tested** (this machine).
- Windows/Linux adapters: interface defined, **Not Yet Tested** (later milestone).

## Milestone 4+ — not started

Security hardening + privileged helper, voice, remote dashboard, MCP plugins, packaging.
