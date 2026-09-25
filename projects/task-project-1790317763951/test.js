import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error("FAIL: no <script> block found in index.html");
  process.exit(1);
}

const context = vm.createContext({
  document: { getElementById: () => ({}), querySelectorAll: () => [], addEventListener: () => {} },
  Number, String, Array,
});
let calculate;
try {
  vm.runInContext(match[1], context);
  calculate = context.calculate;
} catch (e) {
  console.error("FAIL: could not evaluate calculator script:", e.message);
  process.exit(1);
}

if (typeof calculate !== "function") {
  console.error("FAIL: calculate() not defined in index.html");
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(desc, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${desc} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

check("2 + 3 = 5", calculate(2, "+", 3), 5);
check("10 - 4 = 6", calculate(10, "-", 4), 6);
check("6 * 7 = 42", calculate(6, "*", 7), 42);
check("8 / 2 = 4", calculate(8, "/", 2), 4);
check("7 / 2 = 3.5", calculate(7, "/", 2), 3.5);
check("-3 + 3 = 0", calculate(-3, "+", 3), 0);
check("0.1 + 0.2 (float)", calculate(0.1, "+", 0.2), 0.1 + 0.2);
check("2.5 * 4 = 10", calculate(2.5, "*", 4), 10);
check("x / 0 = Error", calculate(5, "/", 0), "Error");
check("0 / 0 = Error", calculate(0, "/", 0), "Error");
check("x * 0 = 0", calculate(5, "*", 0), 0);
check("0 - 5 = -5", calculate(0, "-", 5), -5);
check("bad operand = Error", calculate("abc", "+", 1), "Error");
check("unknown op = Error", calculate(1, "^", 2), "Error");
check("string inputs coerce: '2' * '3' = 6", calculate("2", "*", "3"), 6);
check("10 % 3 = 1", calculate(10, "%", 3), 1);
check("5 % 0 = Error", calculate(5, "%", 0), "Error");

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
