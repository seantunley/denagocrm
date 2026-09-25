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
  resolveFolder,
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

const doc = (id: string, links: Partial<DocFacts> = {}, age = 1): DocFacts & { id: string } => ({
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
  assert.deepEqual(placeDocument(doc("e"), labels), { kind: "company" }, "a file on no record is unfiled");
});

test("A FILE ON A CUSTOMER AND A QUOTE GOES IN THE QUOTE'S FOLDER", () => {
  /*
   * The shape most real documents have: delivery photos, signing paperwork,
   * proofs of payment and invoices are written with BOTH the customer and the
   * quote set. The first version checked the customer first, filed all of them
   * under "General", and left the quote folders nearly empty — and its fixtures
   * only ever gave a file one link, so nothing noticed.
   */
  assert.deepEqual(placeDocument(doc("p", { contactId: "gavin", quoteId: "q1010", tag: "delivery-photo" }), labels), {
    kind: "customer", customerId: "gavin", sub: "quote:q1010", subLabel: "Quote Q-1010",
  });
  assert.equal(
    (placeDocument(doc("j", { contactId: "gavin", jobCardId: "j1" }), labels) as { sub: string }).sub,
    "jobcard:j1",
  );
  assert.equal(
    (placeDocument(doc("v", { contactId: "gavin", vehicleId: "v1" }), labels) as { sub: string }).sub,
    "vehicle:v1",
  );

  const tree = buildFolderTree(
    [doc("1", { contactId: "gavin", quoteId: "q1010" }), doc("2", { contactId: "gavin", quoteId: "q1010" }), doc("3", { contactId: "gavin" })],
    labels,
    now,
  );
  assert.deepEqual(tree.customers[0].subs.map((s) => `${s.label}:${s.count}`), ["General:1", "Quote Q-1010:2"]);

  // The file's own customer names the folder, even when its quote's customer is hidden.
  assert.deepEqual(placeDocument(doc("h", { contactId: "gavin", quoteId: "qHidden" }), labels), {
    kind: "customer", customerId: "gavin", sub: "quote:qHidden", subLabel: "Quote Q-2000",
  });
});

test("A RECORD THE VIEWER MAY NOT OPEN IS NEVER NAMED", () => {
  /*
   * Review finding: the first version loaded quote numbers, job-card numbers and
   * vehicle names for every link, without checking the viewer's access to those
   * records. A document is visible if ANY link is, so someone who can see a file
   * through its customer — but not its quote — saw "Quote Q-5000" in the tree.
   *
   * The label maps now hold only openable records, and a link without a label
   * is treated as absent. "qLocked" below is not in the map: it is a quote this
   * viewer may not open.
   */
  // Visible customer, locked quote: the file shows under the customer's General.
  assert.deepEqual(placeDocument(doc("a", { contactId: "gavin", quoteId: "qLocked" }), labels), {
    kind: "customer", customerId: "gavin", sub: "general", subLabel: "General",
  });
  // Nothing openable at all (e.g. the uploader of a file on a record since
  // lost): no record is named.
  const locked = placeDocument(doc("b", { quoteId: "qLocked" }), labels);
  assert.deepEqual(locked, { kind: "other", sub: "restricted", subLabel: "On records you can't open" });

  const tree = buildFolderTree([doc("a", { contactId: "gavin", quoteId: "qLocked" }), doc("b", { quoteId: "qLocked" })], labels, now);
  assert.ok(!JSON.stringify(tree).includes("qLocked"), "the locked quote's id appears nowhere in the tree");
  assert.ok(!JSON.stringify(tree).includes("Q-5000"), "nor its number");
  // The restricted folder is a real, openable folder that uploads cannot target.
  assert.deepEqual(parseFolder("other", "restricted"), { kind: "other", sub: "restricted" });
  assert.equal(uploadTargetFor(parseFolder("other", "restricted")), null);
});

test("GROUPED ROWS ARE COUNTED BY THEIR SIZE", () => {
  // The page counts its tree from rows grouped by link, so no file is left out
  // however many there are. A row standing for 1,500 files counts as 1,500.
  const tree = buildFolderTree(
    [
      { contactId: "gavin", quoteId: "q1010", vehicleId: null, jobCardId: null, tag: "delivery-photo", count: 1500 },
      { contactId: "gavin", quoteId: "q1010", vehicleId: null, jobCardId: null, tag: "invoice", count: 2 },
      { contactId: null, quoteId: null, vehicleId: null, jobCardId: null, tag: null, count: 700 },
    ],
    labels,
    now,
  );
  assert.equal(tree.all, 2202);
  assert.equal(tree.company, 700);
  assert.deepEqual(tree.customers[0].subs.map((s) => `${s.label}:${s.count}`), ["Quote Q-1010:1502"]);
  assert.equal(tree.recent, 0, "grouped rows carry no date; the page counts Recent separately");
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
  // The folder is built from the SAME permitted set, and only narrows it.
  assert.match(page, /return combos\.size \? \{ AND: \[visibleWhere, \{ OR: \[\.\.\.combos\.values\(\)\] \}\] \} : null;/);
  assert.match(page, /if \(!inFolder\(row, folder, labels\)\) continue;/);
});

test("NO FILE DROPS OUT PAST THE NEWEST 2,000", () => {
  /*
   * Review finding: the page loaded up to 2,000 documents and did foldering and
   * search in memory, so older files — and whole older customer folders —
   * vanished past that number, and search could not find them.
   */
  assert.ok(!/take: 2000/.test(page), "no cap on what the tree or search can see");
  assert.match(
    page,
    /prisma\.document\.groupBy\(\{\s*by: \["contactId", "quoteId", "vehicleId", "jobCardId", "tag"\],\s*where: visibleWhere,/,
    "the tree is counted by the database over every visible file",
  );
  assert.match(page, /\.\.\.\(q \? \[\{ fileName: \{ contains: q, mode: "insensitive" as const \} \}\] : \[\]\),/, "search runs in the database");
  assert.match(page, /prisma\.document\.count\(\{ where: listWhere \}\)/, "the page knows how many match, beyond what it shows");
  assert.match(page, /\{listMatching > listDocs\.length && \(/, "and says so when the list is capped");
  assert.match(page, /const listMatching = inLibrary \? libraryMatching : matching;/);
});

test("RECORD LABELS ARE LOADED ONLY FOR RECORDS THE VIEWER MAY OPEN", () => {
  for (const [model, accessible] of [
    ["vehicle", "vehicleIds"],
    ["jobCard", "jobCardIds"],
    ["quote", "quoteIds"],
  ]) {
    assert.match(
      page,
      new RegExp(`prisma\\.${model}\\.findMany\\(\\{\\s*where: \\{ id: \\{ in: openable\\(ids\\(\\(row\\) => row\\.\\w+\\), ${accessible}\\) \\} \\},`),
      `${model} labels are filtered by the viewer's access`,
    );
  }
  assert.match(page, /getAccessibleJobCardIds\(user\)/);
});

test("PREVIEWS AND UPLOADS GO THROUGH THE CHECKED PATHS", () => {
  const browser = src("src/components/documents/DocumentBrowser.tsx");
  // Every thumbnail, preview and download is the permission-checked file route —
  // never a storage URL, which would bypass the access check.
  assert.ok(!/blob\.vercel-storage|storedName/.test(browser), "no direct storage reference");
  // One helper names the route: /api/files for a record document, /api/library
  // for a Library item — both check access before serving a byte.
  assert.match(
    browser,
    /const fileHref = \(doc: BrowserDoc\) => \(doc\.library \? `\/api\/library\/\$\{doc\.library\.versionId\}` : `\/api\/files\/\$\{doc\.id\}`\);/,
  );
  assert.equal(browser.match(/`\/api\/(files|library)\//g)?.length, 2, "no file URL is built anywhere but fileHref");
  assert.match(browser, /src=\{fileHref\(doc\)\}/);
  assert.match(browser, /src=\{fileHref\(previewing\)\}/);
  // Uploads go through the shared hook: direct to storage, then registered.
  assert.match(browser, /useDocumentUploads\(acceptsUploads \? uploadTarget : null, uploadTenantId\)/);
});

/* ── the Library, merged in ────────────────────────────────────────── */

test("EACH HALF OF THE PAGE OPENS ONLY FOR ITS OWN PERMISSION", () => {
  const library = parseFolder("library", undefined, "Price list");
  const customer = parseFolder("customer:gavin", "quote:q1010");
  const both = { canSeeDocuments: true, canLibrary: true };
  const libraryOnly = { canSeeDocuments: false, canLibrary: true };
  const documentsOnly = { canSeeDocuments: true, canLibrary: false };

  assert.deepEqual(resolveFolder(library, both), { kind: "library", category: "Price list" });
  assert.deepEqual(resolveFolder(customer, both), customer);
  // Library-only access: every record folder becomes the Library, so a URL
  // cannot put a customer's folder in front of them.
  assert.deepEqual(resolveFolder(customer, libraryOnly), { kind: "library", category: null });
  assert.deepEqual(resolveFolder({ kind: "company" }, libraryOnly), { kind: "library", category: null });
  assert.deepEqual(resolveFolder(library, libraryOnly), library);
  // No library access: the Library by URL shows All files instead.
  assert.deepEqual(resolveFolder(library, documentsOnly), { kind: "all" });

  // And the page queries no record documents at all for library-only access,
  // stated outright rather than left to getAccessibleDocumentIds.
  assert.match(page, /\.\.\.\(canSeeDocuments \? \[\] : \[\{ id: \{ in: \[\] as string\[\] \} \}\]\),/);
  assert.match(page, /const folder = resolveFolder\(parseFolder\(params\.folder, params\.sub, params\.cat\), \{ canSeeDocuments, canLibrary \}\);/);
  // The Library's rows are only read with library access.
  assert.match(page, /\] = canLibrary\s*\? await Promise\.all\(\[\s*prisma\.libraryDocument\.groupBy/);
});

test("THE LIBRARY FOLDER IN THE URL", () => {
  assert.deepEqual(parseFolder("library", undefined), { kind: "library", category: null });
  assert.deepEqual(parseFolder("library", undefined, "  Brochure "), { kind: "library", category: "Brochure" });
  assert.deepEqual(parseFolder("library", undefined, "x".repeat(61)), { kind: "library", category: null }, "bounded");
  assert.deepEqual(parseFolder("library", undefined, "a\u0000b"), { kind: "library", category: null }, "printable");
  assert.equal(folderHref({ kind: "library", category: "Price list" }), "/documents?folder=library&cat=Price+list");
  assert.equal(folderHref({ kind: "library", category: null }), "/documents?folder=library");

  // No record Document is ever in the Library, and nothing uploads into it as one:
  // Library items are LibraryDocuments, added through the Library's own form.
  assert.equal(inFolder(doc("1"), parseFolder("library", undefined), labels, now), false);
  assert.equal(uploadTargetFor(parseFolder("library", undefined)), null);
});

test("OLD LIBRARY LINKS AND THE NAV LEAD TO THE MERGED PAGE", () => {
  const redirectPage = src("src/app/(app)/library/page.tsx");
  assert.match(redirectPage, /redirect\(folderHref\(\{ kind: "library", category: cat\?\.trim\(\) \|\| null \}\)\)/);
  // The layout's library permission check still guards the redirect.
  assert.match(src("src/app/(app)/library/layout.tsx"), /requireAnyPermission\("library\.view", "library\.manage"\)/);

  // EVERY guard on the way to the page admits library access — the page's own
  // and its layout's. The layout was missed at first, and library-only users
  // were bounced to the dashboard before the page could show them the Library.
  for (const file of ["src/app/(app)/documents/layout.tsx", "src/app/(app)/documents/page.tsx"]) {
    const guard = src(file).match(/requireAnyPermission\(([^)]*)\)/)?.[1] ?? "";
    assert.match(guard, /"library\.view",\s*"library\.manage"/, `${file} admits library access`);
  }

  const nav = src("src/components/nav-config.ts");
  assert.ok(!nav.includes('href: "/library"'), "no second nav entry for the Library");
  assert.match(nav, /"document_templates\.manage", "library\.view", "library\.manage"\)\) \{\s*crmLinks\.push\(\{ href: "\/documents"/);

  // Changes made from the Documents page refresh the Documents page.
  const actions = src("src/app/actions/library.ts");
  assert.ok(!actions.includes('revalidatePath("/library")'));
  assert.equal(actions.match(/revalidatePath\("\/documents"\)/g)?.length, 3);
});

test("LIBRARY AND PORTAL DOWNLOADS STREAM, AS /api/files DOES", () => {
  // A buffered response over 4.5 MB fails on Vercel. Both routes keep their
  // ownership check: openFileStream makes the same checks readFile did.
  for (const route of ["src/app/api/library/[id]/route.ts", "src/app/api/portal/documents/[id]/route.ts"]) {
    const source = src(route);
    assert.ok(!/\breadFile\(/.test(source), `${route} no longer buffers the file`);
    assert.match(source, /await openFileStream\(\w+\.storedName, \w+\.tenantId\)/, `${route} streams, with the row's tenant`);
  }
});
