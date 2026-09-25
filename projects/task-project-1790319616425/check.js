import fs from "fs";
import path from "path";

const expected = "JARVIS_STOP_TEST";
const target = path.join(import.meta.dirname, "hello.txt");

let actual;
try {
  actual = fs.readFileSync(target, "utf8");
} catch (e) {
  console.error(`FAIL: could not read ${target}: ${e.code || e.message}`);
  process.exit(1);
}

if (actual !== expected) {
  console.error(`FAIL: content mismatch — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  process.exit(1);
}

console.log("PASS: hello.txt contains exactly JARVIS_STOP_TEST");
