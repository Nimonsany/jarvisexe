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

## Milestone 2+ — not started

Tauri UI, ComputerController, voice, dashboard, MCP plugins, packaging.

## Acceptance criteria (Milestone 1)

One owner command → ChatGPT planning via browser → OpenCode execution →
automatic correction loop on failure → independent verification → COMPLETED.
No copy/paste. No OpenAI API.
