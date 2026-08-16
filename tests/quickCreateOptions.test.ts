import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

test("every Quick Create options read is bound to the acting workspace", () => {
  const route = source("src/app/api/quick-create/route.ts");
  assert.match(route, /return withActingStaffScope\(async \(\) => \{/);
  assert.match(route, /prisma\.product\.findMany/);
  assert.match(route, /prisma\.contact\.findMany/);
});

test("the client requests and caches options per create kind", () => {
  const dialog = source("src/components/QuickCreateDialog.tsx");
  assert.match(dialog, /quick-create\?kind=/);
  assert.match(dialog, /optionsKind === kind/);
  assert.match(dialog, /const currentOptions = optionsKind === kind \? options : null/);
});

test("a create sheet does not load unrelated option families", () => {
  const route = source("src/app/api/quick-create/route.ts");
  assert.match(route, /kind === "quote"/);
  assert.match(route, /kind === "jobcard"/);
  assert.match(route, /\["lead", "vehicle", "calendar"\]\.includes\(kind\)/);
  assert.match(route, /!kind \? getSetting\("QUOTE_VALID_DAYS"\) : Promise\.resolve\(null\)/);
});
