import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const code = fs.readFileSync("src/app/actions/fulfilment.ts", "utf8");

test("delivery photo failures are searchable and keep successful batch progress", () => {
  const action = code.slice(code.indexOf("export async function uploadDeliveryPhotos"), code.indexOf("export async function markDelivered"));
  assert.match(action, /for \(const \[index, file\].*\.entries\(\)\)/s);
  assert.match(action, /await logError\(\s*"delivery-photo-upload"/s);
  assert.match(action, /if \(saved === 0\)/);
  assert.match(action, /Settings → System Log/);
  assert.match(action, /const skipped = rejected \+ overCap \+ failed/);
});

test("a database filing failure compensates the already-written blob", () => {
  const helper = code.slice(code.indexOf("async function attachStageDocument"), code.indexOf("function pickFile"));
  assert.match(helper, /const storedName = await saveFile/);
  assert.match(helper, /await prisma\.document\.create/);
  assert.match(helper, /await deleteFile\(storedName\)\.catch/);
  assert.match(helper, /await logError\(\s*"delivery-photo-cleanup"/s);
  assert.doesNotMatch(helper, /deleteFile\(storedName\)\.catch\(\(\) => \{\}\)/);
});
