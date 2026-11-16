import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * BIG FILES MAY NOT GROW (Sean, 2026-11-16: "We need to start the plan to split the big files" —
 * docs/file-split-plan-2026-11-16.md). AGENTS.md says a new feature goes in its own file; this makes CI say it too.
 *
 * Every source file over BIG_BYTES is listed in tests/fixtures/big-files.json with its size. It may grow by GROWTH_BYTES
 * at most — room for the few lines that wire a new file in, not for a feature. It may shrink as much as you like.
 * A file newly crossing BIG_BYTES fails, ALWAYS: split it instead. Nothing can add it to the list.
 *
 * Shrunk a listed file, or split one below the line? Record it:  UPDATE_BIG_FILES=1 npm run test:unit
 * The update only ever lowers a listed size or drops a file. It never raises one and never adds one (review of #1140:
 * adding a new big file through the update would have laundered it past the guard).
 */

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BASELINE = join(root, "tests", "fixtures", "big-files.json");
const BIG_BYTES = 60 * 1024;
const GROWTH_BYTES = 3 * 1024;

type Sizes = Record<string, number>;

/** The list after an update: listed files only — each at the smaller of its recorded and current size — and none that went. */
function nextBaseline(stored: Sizes, current: ReadonlyMap<string, number>): Sizes {
  const next: Sizes = {};
  for (const file of Object.keys(stored).sort()) {
    const bytes = current.get(file);
    if (bytes === undefined || bytes <= BIG_BYTES) continue; // split below the line, or gone
    next[file] = Math.min(stored[file], bytes);
  }
  return next;
}

/** Everything wrong, against a list. */
function problems(stored: Sizes, current: ReadonlyMap<string, number>) {
  const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
  return {
    grown: Object.entries(stored)
      .filter(([file, bytes]) => (current.get(file) ?? 0) > bytes + GROWTH_BYTES)
      .map(([file, bytes]) => `${file}: ${kb(bytes)} → ${kb(current.get(file)!)}`),
    fresh: [...current].filter(([file, bytes]) => bytes > BIG_BYTES && !(file in stored)).map(([file, bytes]) => `${file}: ${kb(bytes)}`),
    stale: Object.keys(stored).filter((file) => !current.has(file) || current.get(file)! <= BIG_BYTES),
  };
}

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
let stored: Sizes = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
if (process.env.UPDATE_BIG_FILES) {
  stored = nextBaseline(stored, current);
  writeFileSync(BASELINE, `${JSON.stringify(stored, null, 2)}\n`);
  // The checks below read the list just written (review of #1140), so a valid update exits green in one run.
}

test("a big file may not grow by more than its wire-in lines", () => {
  const { grown } = problems(stored, current);
  assert.deepEqual(grown, [], `put the new code in its own file and wire it in (AGENTS.md):\n${grown.join("\n")}`);
});

test("no new file crosses the line — split it before it lands (the update can't add it either)", () => {
  const { fresh } = problems(stored, current);
  assert.deepEqual(fresh, [], `over ${BIG_BYTES / 1024} KB:\n${fresh.join("\n")}`);
});

test("the list holds only files that still exist and are still big", () => {
  const { stale } = problems(stored, current);
  assert.deepEqual(stale, [], `split below the line or gone — drop them with UPDATE_BIG_FILES=1:\n${stale.join("\n")}`);
});

test("the update never launders: a new 100 KB file is refused in both modes; a listed file only ever shrinks or drops", () => {
  const list: Sizes = { "src/lib/old.ts": 90_000, "src/lib/gone.ts": 70_000, "src/lib/split.ts": 80_000 };
  const now = new Map([
    ["src/lib/old.ts", 85_000], // shrank
    ["src/lib/split.ts", 20_000], // split below the line
    ["src/lib/newMegaFeature.ts", 100_000], // new and big
  ]);
  const updated = nextBaseline(list, now);
  assert.deepEqual(updated, { "src/lib/old.ts": 85_000 }, "the new file is NOT added; the gone and split ones are dropped; the shrink is recorded");
  assert.deepEqual(problems(list, now).fresh, ["src/lib/newMegaFeature.ts: 98 KB"], "normal run: refused");
  assert.deepEqual(problems(updated, now).fresh, ["src/lib/newMegaFeature.ts: 98 KB"], "after an update: still refused");
  assert.deepEqual(problems(updated, now).stale, [], "the update itself leaves nothing stale");
  // Never raised: a listed file that grew keeps its recorded size, and the growth check still sees it.
  const grew = new Map([["src/lib/old.ts", 95_000]]);
  assert.deepEqual(nextBaseline(list, grew), { "src/lib/old.ts": 90_000 });
  assert.deepEqual(problems(nextBaseline(list, grew), grew).grown, ["src/lib/old.ts: 88 KB → 93 KB"]);
});
