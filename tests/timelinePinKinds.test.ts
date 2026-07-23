import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const appSource = readFileSync(
  fileURLToPath(new URL("../src/lib/timelinePins.ts", import.meta.url)),
  "utf8",
);
const migrationSource = readFileSync(
  fileURLToPath(
    new URL(
      "../prisma/migrations/20260723160000_expand_timeline_pin_kinds/migration.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

function quotedValues(source: string): string[] {
  return [...source.matchAll(/["']([a-z_]+)["']/g)].map((match) => match[1]);
}

test("TimelinePin database constraint allows every application pin kind", () => {
  const appKindsBlock = appSource.match(
    /const\s+PIN_KINDS\s*=\s*\[([\s\S]*?)\]\s+as const/,
  );
  assert.ok(appKindsBlock, "could not parse PIN_KINDS from timelinePins.ts");

  const checkBlock = migrationSource.match(
    /CHECK\s*\(\s*"kind"\s+IN\s*\(([^)]*)\)\s*\)/i,
  );
  assert.ok(checkBlock, "could not parse TimelinePin kind CHECK constraint");

  const appKinds = [...new Set(quotedValues(appKindsBlock[1]))].sort();
  const databaseKinds = [...new Set(quotedValues(checkBlock[1]))].sort();

  assert.deepEqual(databaseKinds, appKinds);
  assert.deepEqual(appKinds, [
    "activity",
    "communication",
    "contact_note",
    "lead_note",
  ]);
});

test("TimelinePin kind migration replaces and validates the named constraint", () => {
  assert.match(
    migrationSource,
    /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+"TimelinePin_kind_check"/i,
  );
  assert.match(
    migrationSource,
    /VALIDATE\s+CONSTRAINT\s+"TimelinePin_kind_check"/i,
  );
});
