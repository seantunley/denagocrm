import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildFolderTree,
  folderHref,
  inFolder,
  parseFolder,
  placeDocument,
  uploadTargetFor,
  type DocFacts,
  type RecordLabels,
} from "../src/lib/documentFolders";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The Documents page was one flat list of every file, newest first. Folders are
 * now derived from the records files are filed against. These tests execute the
 * placement rules — including the one that is also a permission rule.
 */

const now = new Date("2026-09-25T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

const doc = (id: string, links: Partial<DocFacts> = {}, age = 1): DocFacts => ({
  id,
  contactId: null,
  vehicleId: null,
  jobCardId: null,
  quoteId: null,
  tag: null,
  createdAt: daysAgo(age),
  ...links,
});

// Gavin is visible to this viewer; "hidden" is a customer they may not see.
const labels: RecordLabels = {
  contacts: new Map([
    ["gavin", "Gavin Tagg"],
    ["anna", "Anna Smit"],
  ]),
  vehicles: new Map([["v1", { label: "Denago Rover", contactId: "gavin" }]]),
  jobCards: new Map([["j1", { number: 42, contactId: "gavin" }]]),
  quotes: new Map([
    ["q1010", { number: 1010, contactId: "gavin" }],
    ["q1009", { number: 1009, contactId: "gavin" }],
    ["q999", { number: 999, contactId: "gavin" }],
    ["qHidden", { number: 2000, contactId: "hidden" }],
    ["qNoCustomer", { number: 3000, contactId: null }],
  ]),
};

/* ── placement ─────────────────────────────────────────────────────── */

test("A FILE GOES IN THE FOLDER OF THE RECORD IT IS FILED ON", () => {
  assert.deepEqual(placeDocument(doc("a", { contactId: "gavin" }), labels), {
    kind: "customer", customerId: "gavin", sub: "general", subLabel: "General",
  });
  assert.deepEqual(placeDocument(doc("b", { quoteId: "q1010" }), labels), {
    kind: "customer", customerId: "gavin", sub: "quote:q1010", subLabel: "Quote Q-1010",
  });
  assert.deepEqual(placeDocument(doc("c", { vehicleId: "v1" }), labels), {
    kind: "customer", customerId: "gavin", sub: "vehicle:v1", subLabel: "Denago Rover",
  });
  assert.deepEqual(placeDocument(doc("d", { jobCardId: "j1" }), labels), {
    kind: "customer", customerId: "gavin", sub: "jobcard:j1", subLabel: "Job card #42",
  });
  assert.deepEqual(placeDocument(doc("e"), labels), { kind: "company" }, "a file on no record is a company file");
});

test("A HIDDEN CUSTOMER'S NAME NEVER BECOMES A FOLDER", () => {
  /*
   * A file can be visible through a quote while the customer behind that quote
   * is not. A folder named after that customer would disclose the name, so the
   * file is placed under Other records, labelled by the record itself.
   */
  const placed = placeDocument(doc("x", { quoteId: "qHidden" }), labels);
  assert.deepEqual(placed, { kind: "other", sub: "quote:qHidden", subLabel: "Quote Q-2000" });

  const tree = buildFolderTree([doc("x", { quoteId: "qHidden" })], labels, now);
  assert.equal(tree.customers.length, 0, "no customer folder is created for it");
  assert.ok(!JSON.stringify(tree).includes("hidden"), "the hidden customer's id appears nowhere in the tree");

  // A quote with no customer at all lands in the same place.
  assert.equal(placeDocument(doc("y", { quoteId: "qNoCustomer" }), labels).kind, "other");
});

/* ── the tree ──────────────────────────────────────────────────────── */

test("THE TREE COUNTS EVERY FOLDER AND ORDERS IT FOR READING", () => {
  const docs = [
    doc("1", { quoteId: "q1010" }, 2),
    doc("2", { quoteId: "q1010" }, 2),
    doc("3", { quoteId: "q1009" }, 40),
    doc("4", { contactId: "gavin" }, 5),
    doc("5", { contactId: "anna" }, 60),
    doc("6", {}, 3),
    doc("7", { quoteId: "qHidden" }, 90),
  ];
  const tree = buildFolderTree(docs, labels, now);

  assert.equal(tree.all, 7);
  assert.equal(tree.recent, 4, "30 days: 1, 2, 4 and 6");
  assert.equal(tree.company, 1);
  assert.equal(tree.other.count, 1);

  assert.deepEqual(tree.customers.map((c) => [c.name, c.count]), [["Anna Smit", 1], ["Gavin Tagg", 4]], "customers by name");
  const gavin = tree.customers.find((c) => c.id === "gavin")!;
  assert.deepEqual(
    gavin.subs.map((s) => `${s.label}:${s.count}`),
    ["General:1", "Quote Q-1009:1", "Quote Q-1010:2"],
    "General first, then records in numeric order — Q-1009 before Q-1010",
  );

  // Where plain alphabetical order would get it wrong: "Denago Rover" sorts
  // before "General" alphabetically, and "Q-999" after "Q-1010".
  const tricky = buildFolderTree(
    [doc("a", { quoteId: "q1010" }), doc("b", { quoteId: "q999" }), doc("c", { vehicleId: "v1" }), doc("d", { contactId: "gavin" })],
    labels,
    now,
  );
  assert.deepEqual(
    tricky.customers[0].subs.map((s) => s.label),
    ["General", "Denago Rover", "Quote Q-999", "Quote Q-1010"],
    "General is always first, and quote numbers sort as numbers",
  );
});

/* ── the folder in the URL ─────────────────────────────────────────── */

test("A MALFORMED FOLDER IN THE URL SHOWS ALL FILES, NEVER AN ERROR", () => {
  assert.deepEqual(parseFolder(undefined, undefined), { kind: "all" });
  assert.deepEqual(parseFolder("nonsense", undefined), { kind: "all" });
  assert.deepEqual(parseFolder("customer:../../etc", undefined), { kind: "all" }, "ids are validated");
  assert.deepEqual(parseFolder("customer:gavin", "quote:q1010"), { kind: "customer", customerId: "gavin", sub: "quote:q1010" });
  assert.deepEqual(parseFolder("customer:gavin", "drop table"), { kind: "customer", customerId: "gavin", sub: null }, "a bad sub is ignored");
  assert.deepEqual(parseFolder("company", "general"), { kind: "company" });

  // Round trip.
  const folder = parseFolder("customer:gavin", "quote:q1010");
  assert.equal(folderHref(folder), "/documents?folder=customer%3Agavin&sub=quote%3Aq1010");
  assert.equal(folderHref({ kind: "all" }), "/documents");
  assert.equal(folderHref({ kind: "all" }, { view: "list", q: undefined }), "/documents?view=list");
});

test("A FOLDER ONLY EVER NARROWS THE LIST", () => {
  const docs = [doc("1", { quoteId: "q1010" }), doc("2", { contactId: "gavin" }), doc("3"), doc("4", { quoteId: "qHidden" }, 90)];
  const ids = (folder: string, sub?: string) =>
    docs.filter((d) => inFolder(d, parseFolder(folder, sub), labels, now)).map((d) => d.id);

  assert.deepEqual(ids("all"), ["1", "2", "3", "4"]);
  assert.deepEqual(ids("customer:gavin"), ["1", "2"]);
  assert.deepEqual(ids("customer:gavin", "quote:q1010"), ["1"]);
  assert.deepEqual(ids("customer:gavin", "general"), ["2"]);
  assert.deepEqual(ids("company"), ["3"]);
  assert.deepEqual(ids("other"), ["4"]);
  assert.deepEqual(ids("recent"), ["1", "2", "3"]);
  // Naming the hidden customer in the URL finds nothing: its files are not placed there.
  assert.deepEqual(ids("customer:hidden"), []);
});

/* ── uploading into the open folder ────────────────────────────────── */

test("A FILE DROPPED INTO A FOLDER IS FILED ON THAT FOLDER'S RECORD", () => {
  assert.deepEqual(uploadTargetFor(parseFolder("customer:gavin", undefined)), { kind: "record", field: "contactId", id: "gavin" });
  assert.deepEqual(uploadTargetFor(parseFolder("customer:gavin", "general")), { kind: "record", field: "contactId", id: "gavin" });
  assert.deepEqual(uploadTargetFor(parseFolder("customer:gavin", "quote:q1010")), { kind: "record", field: "quoteId", id: "q1010" });
  assert.deepEqual(uploadTargetFor(parseFolder("customer:gavin", "vehicle:v1")), { kind: "record", field: "vehicleId", id: "v1" });
  assert.deepEqual(uploadTargetFor(parseFolder("customer:gavin", "jobcard:j1")), { kind: "record", field: "jobCardId", id: "j1" });
  assert.deepEqual(uploadTargetFor(parseFolder("company", undefined)), { kind: "company" });
  // As the old flat page did, and the phone's quick capture relies on.
  assert.deepEqual(uploadTargetFor(parseFolder("all", undefined)), { kind: "company" });
  // "Other records" spans many records, so it does not say where a file goes.
  assert.equal(uploadTargetFor(parseFolder("other", undefined)), null);
});

/* ── the page's wiring ─────────────────────────────────────────────── */

const page = src("src/app/(app)/documents/page.tsx");

test("THE PAGE STARTS FROM THE SAME PERMISSION-FILTERED FILES AS BEFORE", () => {
  assert.match(page, /\.\.\.\(documentIds === null \? \[\] : \[\{ id: \{ in: documentIds \} \}\]\)/, "only documents the viewer may see");
  assert.match(page, /\.\.\.\(automotiveOn \? \[\] : \[nonAutomotiveDocumentWhere\(\)\]\)/, "automotive paperwork still hidden when the pack is off");
  assert.match(
    page,
    /contactIds === null \? candidateContactIds : candidateContactIds\.filter\(\(id\) => contactIds\.includes\(id\)\)/,
    "customer names are only fetched for customers the viewer may see",
  );
  assert.match(page, /const inThisFolder = docs\.filter\(\(doc\) => inFolder\(/, "the folder narrows the permitted list");
});

test("PREVIEWS AND UPLOADS GO THROUGH THE CHECKED PATHS", () => {
  const browser = src("src/components/documents/DocumentBrowser.tsx");
  // Every thumbnail, preview and download is the permission-checked file route —
  // never a storage URL, which would bypass the access check.
  assert.ok(!/blob\.vercel-storage|storedName/.test(browser), "no direct storage reference");
  assert.match(browser, /src=\{`\/api\/files\/\$\{doc\.id\}`\}/);
  assert.match(browser, /src=\{`\/api\/files\/\$\{previewing\.id\}`\}/);
  // Uploads use the existing action, which authorises the target server-side.
  assert.match(browser, /await uploadDocument\(form\);/);
  assert.match(browser, /if \(uploadTarget\.kind === "record"\) form\.set\(uploadTarget\.field, uploadTarget\.id\);/);
  assert.match(browser, /const MAX_UPLOAD_BYTES = 4 \* 1024 \* 1024;/, "files the platform would refuse are explained, not failed silently");
});
