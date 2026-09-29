import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/app/actions/fulfilment.ts"), "utf8").replace(/\r\n/g, "\n");

const actions = [
  "markInvoiced",
  "markDepositPaid",
  "scheduleDelivery",
  "registerDeliveryPhotos",
  "uploadDeliveryPhotos",
  "markDelivered",
] as const;

function actionSource(name: (typeof actions)[number]): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const following = actions
    .map((candidate) => source.indexOf(`export async function ${candidate}`, start + 1))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0];
  return source.slice(start, following ?? source.length);
}

test("fulfilment actions bind the acting staff workspace around the whole action body", () => {
  assert.match(source, /import \{ withActingStaffScope \} from "@\/lib\/actingScope";/);
  assert.match(
    source,
    /function asFulfilmentAction\([\s\S]*?asActionResult\(\(\) => withActingStaffScope\(body\), options\)/,
  );

  for (const name of actions) {
    assert.match(
      actionSource(name),
      /return asFulfilmentAction\(async \(\) => \{/,
      `${name} must use the enclosing tenant-scope wrapper`,
    );
  }
});
