// Redact likely secrets before ANY content is sent to the ChatGPT browser.
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]'], // JWT
  [/\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{20,}\b/gi, '[REDACTED_SECRET]'],
  [/\b(?:AKIA|ASIA|GOOG|AIza|ghp_|gho_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9\-_]{8,}\b/g, '[REDACTED_SECRET]'],
  // key = value / Authorization: value — keep the key, redact the value
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|authorization)\b(\s*[:=]\s*["']?)[^\s"'\n,;]{4,}/gi, '$1$2[REDACTED_SECRET]'],
  [/bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_SECRET]'],
];

// connection-string credentials: redact user:pass@ while keeping protocol/host
const CONN_RE = /\b((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/)[^@\s]+@/gi;

export function sanitize(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) {
    out = out.replace(re, rep);
  }
  out = out.replace(CONN_RE, '$1[REDACTED_SECRET]@');
  return out;
}

export function sanitizeTruncated(input: string, maxLen = 6000): string {
  const s = sanitize(input);
  return s.length > maxLen ? s.slice(0, maxLen) + '\n...[truncated]' : s;
}
