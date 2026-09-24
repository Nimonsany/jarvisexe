export interface ParsedPlan {
  plan: string;             // full response, always retained
  opencodePrompt: string;   // extracted master prompt or fallback
  usedFallback: boolean;
}

const MASTER_RE = /===\s*OPENCODE MASTER PROMPT\s*===\s*([\s\S]*?)(?:\n===|$)/i;
const CORRECTIVE_RE = /===\s*OPENCODE CORRECTIVE PROMPT\s*===\s*([\s\S]*?)(?:\n===|$)/i;

export function parsePlanResponse(response: string): ParsedPlan {
  const m = response.match(MASTER_RE);
  if (m && m[1].trim().length > 50) {
    return { plan: response, opencodePrompt: m[1].trim(), usedFallback: false };
  }
  return {
    plan: response,
    opencodePrompt: fallbackMasterPrompt(response),
    usedFallback: true,
  };
}

export function parseCorrectiveResponse(response: string): string {
  const m = response.match(CORRECTIVE_RE);
  return m && m[1].trim().length > 20 ? m[1].trim() : response;
}

function fallbackMasterPrompt(plan: string): string {
  return `You are an autonomous coding agent working in the project directory.
Implement the following plan phase-by-phase. Rules:
1. Inspect existing files before modifying anything; preserve valuable work.
2. Implement the minimum safe solution per phase.
3. Run relevant tests after each phase; review diffs.
4. Report actual failures honestly — never claim tests passed unless they ran.
5. Never expose secrets; never perform destructive OS actions outside the project.

PLAN:
${plan}`;
}
