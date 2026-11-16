import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * BIG FILES MAY NOT GROW (Sean, 2026-11-16: "We need to start the plan to split the big files" —
 * docs/file-split-plan-2026-11-16.md). AGENTS.md says a new feature goes in its own file; this makes CI say it too.
 *
 * Every source file over BIG_BYTES is listed in tests/fixtures/big-files.json with its size. It may grow by GROWTH_BYTES
 * at most — room for the few lines that wire a new file in, not for a feature. It may shrink as much as you like.
 * A file newly crossing BIG_BYTES fails as well: split it instead.
 *
 * Shrunk a listed file, or split one below the line? Record it:  UPDATE_BIG_FILES=1 npm run test:unit
 * The update only ever lowers a size or drops a file — it never raises one.
 */

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE = join(root, "tests", "fixtures", "big-files.json");
export const BIG_BYTES = 60 * 1024;
export const GROWTH_BYTES = 3 * 1024;

/** Bytes as committed: line endings folded, so a Windows checkout measures what CI measures. */
const size = (file: string) => Buffer.byteLength(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n"));

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(rel);
    return /\.(ts|tsx)$/.test(entry.name) ? [rel] : [];
  });
}

const current = new Map(sources("src").map((file) => [file, size(file)] as const));
const stored: Record<string, number> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

if (process.env.UPDATE_BIG_FILES) {
  const next: Record<string, number> = {};
  for (const [file, bytes] of [...current].sort(([a], [b]) => a.localeCompare(b))) {
    if (bytes <= BIG_BYTES) continue;
    // Never raised: a listed file keeps the smaller of its recorded and current size; a new one is recorded once.
    next[file] = file in stored ? Math.min(stored[file], bytes) : bytes;
  }
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
}

test("a big file may not grow by more than its wire-in lines", () => {
  const grown = Object.entries(stored)
    .filter(([file]) => current.has(file))
    .filter(([file, bytes]) => current.get(file)! > bytes + GROWTH_BYTES)
    .map(([file, bytes]) => `${file}: ${Math.round(bytes / 1024)} KB → ${Math.round(current.get(file)! / 1024)} KB`);
  assert.deepEqual(grown, [], `put the new code in its own file and wire it in (AGENTS.md):\n${grown.join("\n")}`);
});

test("no new file crosses the line — split it before it lands", () => {
  const fresh = [...current].filter(([file, bytes]) => bytes > BIG_BYTES && !(file in stored)).map(([file, bytes]) => `${file}: ${Math.round(bytes / 1024)} KB`);
  assert.deepEqual(fresh, [], `over ${BIG_BYTES / 1024} KB:\n${fresh.join("\n")}`);
});

test("the list holds only files that still exist and are still big", () => {
  const stale = Object.keys(stored).filter((file) => !current.has(file) || current.get(file)! <= BIG_BYTES);
  assert.deepEqual(stale, [], `split below the line or gone — drop them with UPDATE_BIG_FILES=1:\n${stale.join("\n")}`);
  assert.equal(relative(root, BASELINE).replace(/\\/g, "/"), "tests/fixtures/big-files.json");
});
