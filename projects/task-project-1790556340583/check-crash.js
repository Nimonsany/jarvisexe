import fs from 'node:fs';

const htmlPath = new URL('./crash.html', import.meta.url);

function fail(message) {
  console.error(`M8_CRASH_RECOVERY_TEST_FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(htmlPath)) {
  fail('crash.html does not exist');
}

let html;
try {
  html = fs.readFileSync(htmlPath, 'utf8');
} catch (err) {
  fail(`crash.html cannot be read: ${err.message}`);
}

const checks = [
  ['HTML document', /<!doctype html>/i],
  ['status element', /id="status"/],
  ['button', /<button\b/i],
  ['button id', /id="crash-button"/],
  ['event listener', /addEventListener\s*\(/],
  ['success marker', /M8_CRASH_RECOVERY_OK/],
];

for (const [name, pattern] of checks) {
  if (!pattern.test(html)) {
    fail(`Missing required ${name}`);
  }
}

console.log('M8_CRASH_RECOVERY_TEST_PASS');
