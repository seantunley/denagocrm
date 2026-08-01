import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "check-visual-consistency.mjs");

/**
 * The guardrail scans `src/` under the CWD, so each case gets a throwaway tree
 * with one planted file. Running the real script as a subprocess tests the
 * guardrail that CI actually runs, rather than a copy of its regex.
 */
function check(files: Record<string, string>): { failed: boolean; output: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "guardrail-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(dir, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
    }
    const run = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
    return { failed: run.status !== 0, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a native dialog in real code still fails", () => {
  // The point of the rule. If this stops failing, the guardrail is decorative.
  for (const call of ["alert(\"saved\")", "window.confirm(\"sure?\")", "prompt(\"name\")"]) {
    const { failed, output } = check({ "src/components/Thing.tsx": `export function f() { ${call}; }` });
    assert.ok(failed, `${call} must fail the guardrail`);
    assert.match(output, /native browser dialogs/);
  }
});

test("a native dialog named in a comment does not", () => {
  // This is what failed on main: doceditor/css.ts and doceditor/model.ts both
  // document the XSS payload they exist to stop, and it contains `alert(1)`.
  const { failed, output } = check({
    "src/lib/css.ts": [
      "/**",
      ' * `#fff" onmouseover="alert(1)" x="` closed the attribute and added an',
      " * event handler on the public signing page.",
      " */",
      "// prompt( and window.confirm( are named here on purpose.",
      "export const SAFE = /^#[0-9a-f]{3,8}$/i;",
    ].join("\n"),
  });
  assert.ok(!failed, `comments must not trip the rule:\n${output}`);
});

test("stripping comments cannot hide a dialog on a line of real code", () => {
  // A mid-line `//` (a URL) must not take the rest of its line with it — that
  // would turn a false positive into a false negative, which is the failure
  // direction that matters for a guardrail.
  const { failed } = check({
    "src/lib/x.ts": `export const go = () => { fetch("https://example.com"); alert("hi"); };`,
  });
  assert.ok(failed, "a dialog after a URL on the same line must still fail");
});

test("member calls on other objects are still ignored", () => {
  const { failed, output } = check({
    "src/lib/y.ts": `import { logger } from "./l";\nexport const go = () => logger.alert("x");`,
  });
  assert.ok(!failed, `logger.alert() is not a browser dialog:\n${output}`);
});

test("the repository itself passes", () => {
  // The regression that started this: main was red on the guardrails job while
  // tsc, lint, the unit suite and npm audit were all green, so nothing else
  // would have caught it.
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});
