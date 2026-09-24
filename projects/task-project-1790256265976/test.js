"use strict";

import assert from "node:assert/strict";

// Contract copy of calculate() from index.html — kept identical on purpose.
function calculate(a, b, operator) {
  if (typeof a !== "number" || typeof b !== "number" ||
      !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error("Invalid input: both operands must be finite numbers");
  }
  switch (operator) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
      if (b === 0) throw new Error("Division by zero is not allowed");
      return a / b;
    default:
      throw new Error("Unsupported operator: " + operator);
  }
}

const tests = [
  ["addition", () => assert.equal(calculate(2, 3, "+"), 5)],
  ["subtraction", () => assert.equal(calculate(10, 4, "-"), 6)],
  ["multiplication", () => assert.equal(calculate(3, 5, "*"), 15)],
  ["division", () => assert.equal(calculate(20, 4, "/"), 5)],
  ["zero", () => assert.equal(calculate(0, 0, "+"), 0)],
  ["negative values", () => assert.equal(calculate(-4, 2, "+"), -2)],
  ["decimal multiplication", () => assert.equal(calculate(2.5, 4, "*"), 10)],
  ["fractional division", () => assert.equal(calculate(5, 2, "/"), 2.5)],
  ["division by zero", () => assert.throws(() => calculate(5, 0, "/"), /Division by zero/)],
  ["invalid operator", () => assert.throws(() => calculate(1, 2, "^"), /Unsupported operator/)],
  ["non-number input", () => assert.throws(() => calculate(NaN, 2, "+"), /Invalid input/)],
  ["Infinity input", () => assert.throws(() => calculate(1, Infinity, "+"), /Invalid input/)],
  ["string input type", () => assert.throws(() => calculate("2", 3, "+"), /Invalid input/)],
];

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    process.exit(1);
  }
}
console.log(`\nAll ${passed} calculator tests passed.`);
