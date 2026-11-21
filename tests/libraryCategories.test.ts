import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_LIBRARY_CATEGORIES, chosenLibraryCategory, parseLibraryCategories } from "../src/lib/libraryCategories";
import { isPersonLabel } from "../src/lib/documentLabels";

/**
 * Sean, 2026-11-21: "Why can't I label this a brochure or price list … for this Library?" / "Library work has to be
 * done. Otherwise, How do I label brochures? Price Lists?" — a Library item's category can be changed; a brochure filed
 * on a customer can be moved into the Library under one; the categories are the workspace's own dropdown list.
 */
const code = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

test("the workspace's list: defaults until set, one per line, tidied, no repeats", () => {
  assert.deepEqual(parseLibraryCategories(null), ["Brochure", "Price list", "Spec sheet", "Warranty", "Other"]);
  assert.deepEqual(parseLibraryCategories("  Brochure \nbrochure\n\nPrice   list\nManuals"), ["Brochure", "Price list", "Manuals"]);
  assert.deepEqual(parseLibraryCategories("\n \n"), [...DEFAULT_LIBRARY_CATEGORIES], "an emptied list falls back");
});

test("a save takes a category from the list only — as listed — or none; an old one stays as itself", () => {
  const list = ["Brochure", "Price list"];
  assert.deepEqual(chosenLibraryCategory("price LIST", list), { ok: true, category: "Price list" });
  assert.deepEqual(chosenLibraryCategory("", list), { ok: true, category: null });
  assert.deepEqual(chosenLibraryCategory("<script>", list), { ok: false });
  assert.deepEqual(chosenLibraryCategory("Spec sheet", list, "Spec sheet"), { ok: true, category: "Spec sheet" });
});

test("every save checks the list: uploads, a category change, a move — none stores the browser's text as is", () => {
  const upload = code("src/app/actions/library.ts");
  assert.match(upload, /const chosen = chosenLibraryCategory\(category, listed\);\s*if \(!chosen\.ok\) refuse\(/);
  assert.match(upload, /getWorkspaceSetting\(await actingTenantId\(\), LIBRARY_CATEGORIES_KEY\)/, "the workspace's own list, named by workspace");
  const actions = code("src/app/actions/libraryCategories.ts");
  const change = actions.slice(actions.indexOf("export async function setLibraryCategory"), actions.indexOf("export async function moveDocumentToLibrary"));
  assert.match(change, /requirePermission\("library\.manage"\)/);
  assert.match(change, /prisma\.libraryDocument\.updateMany\(\{ where: \{ id: documentId, tenantId, deletedAt: null \}/);
  assert.match(change, /action: "library\.category_changed"/);
  assert.match(actions, /putWorkspaceSetting\(tenantId, LIBRARY_CATEGORIES_KEY, list\.join\("\\n"\)\)/);
});

test("moving a filed brochure into the Library: its own access AND library.manage; paperwork never moves; copied, then trashed", () => {
  const actions = code("src/app/actions/libraryCategories.ts");
  const move = actions.slice(actions.indexOf("export async function moveDocumentToLibrary"));
  assert.match(move, /requireDocumentAccess\(documentId, "documents\.manage"\);\s*await requirePermission\("library\.manage"\);/);
  assert.match(move, /if \(!isPersonLabel\(doc\.tag\)\) refuse\(/, "EVERY tag the CRM sets stays on its record — not only the labelled ones (review of #1175)");
  for (const tag of ["generated-pdf", "for-signing", "warranty-certificate", "signed", "invoice", "pop", "delivery-note", "checkin-photo"]) {
    assert.equal(isPersonLabel(tag), false, `${tag} is the CRM's`);
  }
  assert.equal(isPersonLabel("Brochure"), true);
  assert.equal(isPersonLabel(null), true);
  // Two clicks at once: the row is held and re-checked live before anything is copied.
  assert.match(move, /FOR UPDATE`;\s*if \(\(held as unknown\[\]\)\.length !== 1\) refuse\(/);
  assert.ok(move.indexOf("FOR UPDATE") < move.indexOf("tx.libraryDocument.create"), "held before the Library copy is made");
  assert.match(move, /prisma\.signatureRequest\.count\(\{ where: \{ documentId \} \}\)/);
  assert.match(move, /const storedName = await saveFile\(bytes, doc\.fileName, doc\.mimeType, tenantId\);/, "a copy of its own, in this workspace");
  assert.match(move, /softDeleteRecord\("document", documentId, "Moved to the Library", user\.name, tx\)/, "the record's copy is restorable");
  assert.match(move, /await deleteFile\(storedName\)\.catch/, "a failed move leaves no orphan file");
  const dialog = code("src/components/RepoRow.tsx");
  assert.match(dialog, /targets\.libraryCategories && targets\.libraryCategories\.length > 0 && isPersonLabel\(doc\.tag\)/);
  assert.match(code("src/app/(app)/documents/page.tsx"), /\.\.\.\(canLibraryManage \? \{ libraryCategories: libraryCategoryList \} : \{\}\)/);
});
