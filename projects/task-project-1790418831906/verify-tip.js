import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const html = fs.readFileSync(path.join(__dirname, 'tip.html'), 'utf8');
const match = html.match(/<script id="tip-logic">([\s\S]*?)<\/script>/);
if (!match) {
  console.error('FAIL: tip-logic script block not found in tip.html');
  process.exit(1);
}
const calcTip = vm.runInNewContext(match[1] + '\ncalcTip');

const cases = [
  [100, 15],
  [0, 0],
  [40, 6],
  [50.5, 7.575],
  [24.66, 3.699],
];

let failed = 0;
for (const [bill, expected] of cases) {
  const got = calcTip(bill);
  if (Math.abs(got - expected) >= 1e-9) {
    console.error(`FAIL: calcTip(${bill}) = ${got}, expected ${expected}`);
    failed++;
  } else {
    console.log(`ok: calcTip(${bill}) = ${got}`);
  }
}

if (failed) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log('All tests passed');
