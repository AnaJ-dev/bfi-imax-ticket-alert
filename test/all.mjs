// Runs every suite. One command: node test/all.mjs
import { spawnSync } from "child_process";

const suites = [
  ["Injected page functions", "unit-injected.mjs"],
  ["Source-level checks",     "unit-behaviour.mjs"],
  ["Pure logic",              "unit-logic.mjs"],
  ["Integration (fake Chrome)", "run.mjs"],
];

let total = 0, failed = 0;
for (const [label, file] of suites) {
  const r = spawnSync(process.execPath, [new URL(file, import.meta.url).pathname], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /(\d+) passed, (\d+) failed/.exec(out);
  const p = m ? +m[1] : 0, f = m ? +m[2] : 1;
  total += p; failed += f;
  console.log(`${f === 0 ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${label.padEnd(28)} ${p} passed${f ? `, ${f} FAILED` : ""}`);
  if (f) console.log(out.split("\n").filter((l) => /FAIL|Error/.test(l)).map((l) => "        " + l).join("\n"));
}
console.log(`\n\x1b[1m${total} tests passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
