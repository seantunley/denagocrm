import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";

// crmAssistant.ts reaches server-only; its pure helpers load with it stubbed.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { viewedByCustomer, quoteFacts } = require("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// Production, 2026-10-05: Q-1022 was sent from the signing hub on 30 Sep and opened
// on 1 Oct — but the quote row itself still said "draft", viewedAt null, so DAX
// answered "not sent yet". The signing request is the record of sending and opening.
const draftRow = { status: "draft", viewedAt: null, signedAt: null };
const hub = { status: "viewed", sentAt: new Date("2026-09-30T13:35:00Z"), viewedAt: new Date("2026-10-01T12:20:00Z"), signedAt: null };

test("a quote sent and opened in the signing hub reads as sent and opened, not 'still a draft'", () => {
  assert.equal(viewedByCustomer(draftRow, hub), "2026-10-01");
  assert.deepEqual(quoteFacts(draftRow, hub), { status: "sent for signature (viewed)", sentForSignature: "2026-09-30", signed: "no" });
});

test("sent from the hub but not opened yet → 'not yet'; never sent at all → 'not sent yet'", () => {
  assert.equal(viewedByCustomer(draftRow, { ...hub, status: "sent", viewedAt: null }), "not yet");
  assert.equal(viewedByCustomer(draftRow), "not sent yet (still a draft)");
  assert.deepEqual(quoteFacts(draftRow), { status: "draft", signed: "no" });
});

test("signed in the hub counts as signed; the quote's own dates still win when it has them", () => {
  const done = { ...hub, status: "completed", signedAt: new Date("2026-10-02T09:00:00Z") };
  assert.equal(quoteFacts(draftRow, done).signed, "2026-10-02");
  const ownRow = { status: "sent", viewedAt: new Date("2026-09-29T08:00:00Z"), signedAt: null };
  assert.equal(viewedByCustomer(ownRow, hub), "2026-09-29");
  assert.equal(quoteFacts(ownRow, hub).status, "sent", "a quote sent the ordinary way keeps its status");
});

test("both quote lookups read the signing hub; its filters never replace the access filter", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib, /where: \{ quoteId: \{ in: quoteIds \}, deletedAt: null, status: \{ notIn: \["draft", "voided"\] \} \}/);
  assert.equal((lib.match(/const signing = await signingFor\(/g) ?? []).length, 2, "find_quotes and lead_brief");
  const find = lib.slice(lib.indexOf("async function findQuotes("), lib.indexOf("async function findActivities("));
  // "Waiting for a signature" includes quotes out in the hub, and "viewed" includes ones opened there.
  assert.match(find, /OR: \[\{ status: "sent" \}, \{ id: \{ in: outForSigning \}, status: \{ in: \["draft", "sent"\] \} \}\]/);
  assert.match(find, /AND: \[\{ OR: \[\{ viewedAt: \{ not: null \} \}, \{ id: \{ in: openedInHub \} \}\] \}\]/);
  assert.match(find, /AND: \[\{ viewedAt: null \}, \{ id: \{ notIn: openedInHub \} \}\]/);
  // No other top-level `id:` key in the where — it would overwrite `id: { in: ids }`.
  const where = find.slice(find.indexOf("const quotes = await prisma.quote.findMany({"), find.indexOf("orderBy:"));
  assert.equal((where.match(/^\s{6}\.\.\.\(ids === null \? \{\} : \{ id: \{ in: ids \} \}\),$/gm) ?? []).length, 1);
  assert.doesNotMatch(where.replace(/OR: \[[^\n]*\]|AND: \[[^\n]*\]/g, ""), /\? \{ [^}]*\bid: \{ notIn/);
});
