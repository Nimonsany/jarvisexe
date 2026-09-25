// Defense-in-depth display sanitizer (mirror of core's sanitize — the UI
// cannot import the Node core module directly). Redacts secrets before render.
const PATTERNS: [RegExp, string | ((m: string) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]'],
  [/\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{20,}\b/gi, '[REDACTED_SECRET]'],
  [/\b(?:AKIA|ASIA|GOOG|AIza|ghp_|gho_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9\-_]{8,}\b/g, '[REDACTED_SECRET]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*["']?)[^\s"'\n,;]{4,}/gi, '$1$2[REDACTED_SECRET]'],
  [/bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_SECRET]'],
  [/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^@\s]+@/gi, (m: string) => `${m.split('://')[0]}://[REDACTED_SECRET]@`],
];

export function sanitize(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, rep as string);
  }
  return out;
}
