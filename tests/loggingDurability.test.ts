import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("the shared error logger has non-recursive console fallbacks", async () => {
  const code = await source("src/lib/errorLog.ts");
  assert.match(code, /\[error-log-write-failure\]/);
  assert.match(code, /\[error-log-alert-failure\]/);
  assert.doesNotMatch(code, /catch\s*\{\s*\/\/ the error logger must never become the error/);
  assert.doesNotMatch(code, /sendPushToAll[\s\S]*?\.catch\(\(\) => \{\}\)/);
});

test("client crashes are persisted to the tenant-aware System Log", async () => {
  const route = await source("src/app/api/client-error/route.ts");
  assert.match(route, /import \{ logError \} from "@\/lib\/errorLog"/);
  assert.match(route, /await logError\(\s*"client-error"/);
  assert.match(route, /\{ alert: false \}/);
  assert.doesNotMatch(route, /\[client-error\].*console\.error/);
});

test("client reporting failures retain a browser-console fallback", async () => {
  for (const path of [
    "src/app/(app)/error.tsx",
    "src/components/dashboard/CardBoundary.tsx",
  ]) {
    const code = await source(path);
    assert.match(code, /\[client-error-report-failure\]/, path);
    assert.doesNotMatch(code, /fetch\("\/api\/client-error"[\s\S]*?\.catch\(\(\) => \{\}\)/, path);
  }
});
