import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Sean, 2026-11-24: "DAX must not be mentioned in the help files, it's my name for the personal assistant. It can
// change." Each workspace names its own assistant (Settings → Assistant), so the guides say "the assistant".
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

test("no help guide names the assistant", () => {
  for (const file of [...files("src/lib/help"), ...files("src/components/help")]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\bDAX\b/i, file);
  }
});

test("the home brief and its plan button use the workspace's own name for the assistant", () => {
  assert.match(readFileSync("src/app/(app)/page.tsx", "utf8"), /\{assistantName\}&apos;s brief for today/);
  assert.match(readFileSync("src/components/DaxBriefCard.tsx", "utf8"), /Ask \{assistantName\} for a plan/);
  for (const file of ["src/lib/proactive.ts", "src/lib/proactiveBrief.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /title: "DAX"/, file);
  }
});
