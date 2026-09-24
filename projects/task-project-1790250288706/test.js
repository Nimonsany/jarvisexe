import fs from 'fs';

const html = fs.readFileSync(new URL('index.html', import.meta.url), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error('FAIL: could not find calculator <script> block in index.html');
  process.exit(1);
}
(0, eval)(match[1]);
const { calculate } = globalThis;

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}` + (ok ? '' : ` -- got ${actual}, expected ${expected}`));
}

check('addition: 2 + 3 = 5', calculate(2, '+', 3), 5);
check('subtraction: 10 - 4 = 6', calculate(10, '-', 4), 6);
check('negative result: 5 - 8 = -3', calculate(5, '-', 8), -3);
check('negative multiplication: 2 * -3 = -6', calculate(2, '*', -3), -6);
check('decimal multiplication: 4 * 2.5 = 10', calculate(4, '*', 2.5), 10);
check('decimal addition precision: 0.1 + 0.2 = 0.3', calculate(0.1, '+', 0.2), 0.3);
check('decimal division: 10 / 4 = 2.5', calculate(10, '/', 4), 2.5);
check('division by zero: 7 / 0 handled', calculate(7, '/', 0), null);
check('zero numerator: 0 / 5 = 0', calculate(0, '/', 5), 0);
check('unknown operator rejected', calculate(2, '^', 3), null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
