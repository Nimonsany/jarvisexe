# PLAN — Multi-Agent Orchestration (agency-agents integration)

Consulted with ChatGPT via the JARVIS browser controller (99s). Owner request:
each task gets its own specialist bot, Context7 load-balanced, roster verified + extended.

## Discovered roster (Desktop/agency-agents)

**275 agent personas × 22 divisions** (frontmatter: name, description, vibe + identity/mission/rules).

## ChatGPT-verified specialist routing (pipeline phase → bot)

| Phase | Bot (division/agent) |
|---|---|
| Intake / routing | `specialized/agents-orchestrator` |
| Codebase discovery | `specialized/codebase-archaeologist` |
| Analyze requirements | `specialized/workflow-architect` |
| Architecture / planning | `specialized/master-plan-architect` |
| Execution coordination | `project-management/project-shepherd` |
| MCP/tool integration | `specialized/mcp-builder` |
| Implementation security check | `security/ai-generated-code-auditor` |
| AppSec review | `security/appsec-engineer` |
| Automated testing | `testing/test-automation-engineer` |
| API validation | `testing/api-tester` |
| Independent final verification | `testing/reality-checker` |
| Documentation / package summary | `specialized/document-generator` + `support/executive-summary-generator` |

Implementation stays with OpenCode; personas supply bounded analysis/review tasks.
**One bot = one task at a time.**

## New personas to ADD (8, ChatGPT-improvised with the 2026 landscape)

1. `software/implementation-engineer` — own ONE approved coding task and nothing else
2. `architecture/dependency-version-governor` — validate package/API compatibility, lock versions
3. `testing/agent-eval-engineer` — evaluate outcome quality, not merely exit codes
4. `platform/sandbox-runtime-guardian` — enforce filesystem/network/command/credential boundaries
5. `observability/agent-trace-analyst` — analyze calls, handoffs, retries, latency, failure loops
6. `release/build-release-engineer` — reproducible build, artifact manifest, checksums
7. `governance/execution-budget-controller` — enforce token/tool/time/retry budgets, kill runaway branches
8. `context/memory-context-curator` — decide what enters context/memory, compaction

## Context7 Broker (load balancing)

```
Agents → Context7 Broker → cache → rate limiter → Context7
                     ↘ singleflight/dedupe
```

- Cache key: `SHA256(libraryId + version + normalizedQuery + language)`
- L1 RAM cache 30 min · L2 disk cache 24 h · resolution cache 24 h
- Singleflight: 15 agents asking the same question = 1 upstream request
- Token bucket: 5 concurrent, configurable req/min; priority (blocking > test > research)
- 429 → obey Retry-After, exponential backoff + jitter
- ONE shared credential — no per-agent credentials; audit every query (agent → query → cache-hit → tokens)

## Safeguards (ChatGPT risk review, mapped to what already exists)

1 task → 1 owner → explicit artifact → independent verifier → bounded retries —
already enforced by the M1-M4 architecture. Added: bot-assignment registry (one
task per bot), budget controller, no circular delegation (bots never spawn bots).

## Build steps (after owner approval)

1. `AgentBotProvider` + bot-assignment registry (one-task-per-bot, phase→bot routing table)
2. Write the 8 new agent personas (agency-agents format: frontmatter + identity/mission/rules)
3. `Context7Broker` (cache/singleflight/rate-limit/backoff/audit)
4. Orchestrator hooks: phase bots consulted at safe checkpoints (analyze/review/verify)
5. UI: agent-bot activity (which bot handled what)
6. Tests + E2E + regression (M1-M8) + push
