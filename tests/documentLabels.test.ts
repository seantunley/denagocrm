import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_DOCUMENT_TYPES, DOCUMENT_TYPES_MAX, SYSTEM_DOCUMENT_TAGS, chosenDocumentType, isPersonLabel, parseDocumentTypes } from "../src/lib/documentLabels";

/*
 * Sean, 2026-10-13: "Need to label an uploaded document… When I upload, it's
 * against Q-1025, Supplier Quote, Proof of Payment Supplier etc." — and of a box
 * to type the label into: "No, must have a drop down we can select".
 */

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the list a workspace starts with has the two he named", () => {
  assert.ok(DEFAULT_DOCUMENT_TYPES.includes("Supplier quote"));
  assert.ok(DEFAULT_DOCUMENT_TYPES.includes("Proof of payment — supplier"));
  assert.deepEqual(parseDocumentTypes(null), [...DEFAULT_DOCUMENT_TYPES]);
  assert.deepEqual(parseDocumentTypes("  \n \n"), [...DEFAULT_DOCUMENT_TYPES], "an emptied list goes back to the standard one");
});

test("the owner's list: tidied, in their order, no repeats, bounded — and never one of the CRM's own tags", () => {
  assert.deepEqual(parseDocumentTypes("Supplier quote\n  Customs   clearance \nsupplier QUOTE\n\nBank guarantee"), ["Supplier quote", "Customs clearance", "Bank guarantee"]);
  // "pop" on the list would make any file labelled with it count as the customer's deposit being paid.
  for (const tag of SYSTEM_DOCUMENT_TAGS) assert.deepEqual(parseDocumentTypes(`Supplier quote\n${tag}\n${tag.toUpperCase()}`), ["Supplier quote"], tag);
  assert.equal(parseDocumentTypes(Array.from({ length: 80 }, (_, i) => `Type ${i}`).join("\n")).length, DOCUMENT_TYPES_MAX);
  assert.equal(parseDocumentTypes("x".repeat(200))[0].length, 60);
});

test("an upload's type must be ON the list, exactly — the dropdown is a convenience, the server is the rule", () => {
  const types = ["Supplier quote", "Proof of payment — supplier"];
  assert.deepEqual(chosenDocumentType("Supplier quote", types), { ok: true, type: "Supplier quote" });
  assert.deepEqual(chosenDocumentType("", types), { ok: true, type: null }, "not labelled is allowed");
  assert.deepEqual(chosenDocumentType(null, types), { ok: true, type: null });
  for (const posted of ["supplier quote", "pop", "signed", "Anything typed", "Supplier quote "]) {
    const result = chosenDocumentType(posted, types);
    // Surrounding space is not a different type; everything else is refused.
    if (posted.trim() === "Supplier quote") assert.deepEqual(result, { ok: true, type: "Supplier quote" });
    else assert.deepEqual(result, { ok: false }, posted);
  }
});

test("a tag the CRM wrote is not a person's label", () => {
  assert.equal(isPersonLabel(null), true);
  assert.equal(isPersonLabel("Supplier quote"), true);
  for (const tag of ["pop", "signed", "invoice", "delivery-note", "checkin-photo", "generated-pdf", "for-signing"]) assert.equal(isPersonLabel(tag), false, tag);
  // Every tag the code writes on a Document is on the protected list.
  const written = new Set<string>();
  for (const file of ["src/app/actions/fulfilment.ts", "src/app/actions/jobcards.ts", "src/app/actions/customDocuments.ts", "src/app/actions/doceditor.ts", "src/app/actions/recordSigning.ts", "src/lib/quoteDelivery.ts", "src/lib/signing/complete.ts"]) {
    for (const match of code(file).matchAll(/\btag: "([a-z-]+)"/g)) written.add(match[1]);
  }
  assert.ok(written.size >= 6, [...written].join(","));
  for (const tag of written) assert.ok(SYSTEM_DOCUMENT_TAGS.has(tag), `${tag} is written by the CRM and is not protected`);
});

test("upload: the type is checked before the file is stored, and saved as the document's tag", () => {
  const actions = code("src/app/actions/documents.ts");
  const upload = actions.slice(actions.indexOf("export async function uploadDocument("), actions.indexOf("export async function registerUploadedDocument("));
  assert.match(upload, /const chosen = chosenDocumentType\(formData\.get\("label"\), parseDocumentTypes\(await getSetting\(DOCUMENT_TYPES_KEY\)\)\);\s*if \(!chosen\.ok\) refuse\(NOT_A_TYPE\);/);
  assert.ok(upload.indexOf("if (!chosen.ok) refuse(NOT_A_TYPE);") < upload.indexOf("await saveFile("), "a refused type leaves no stored file behind");
  assert.match(upload, /tag: chosen\.type,/);
  // Still exactly one authorised target — the quote OR the customer, never both.
  assert.match(actions, /if \(providedCount > 1\) \{\s*throw new Error\("A document can be filed against only one record\."\);/);
  assert.match(upload, /quoteId: target\.kind === "quote" \? target\.quoteId : null,/);
});

test("relabel: only a document they can open, by someone who may upload, only to a listed type, and never over a tag the CRM wrote", () => {
  const actions = code("src/app/actions/documents.ts");
  const relabel = actions.slice(actions.indexOf("export async function relabelDocument("), actions.indexOf("export async function deleteDocument("));
  // The upload permission, not the delete one: a rep must be able to correct a label (found testing as one).
  assert.match(relabel, /const user = await requireDocumentAccess\(id, "documents\.upload"\);/);
  assert.match(relabel, /if \(!chosen\.ok\) refuse\(NOT_A_TYPE\);/);
  // The update itself cannot match a row carrying a system tag, whatever the form says.
  assert.match(relabel, /where: \{ id, deletedAt: null, OR: \[\{ tag: null \}, \{ tag: \{ notIn: \[\.\.\.SYSTEM_DOCUMENT_TAGS\] \} \}\] \},\s*data: \{ tag: chosen\.type \},/);
  assert.match(relabel, /if \(changed\.count !== 1\) refuse\(/);
  assert.match(relabel, /action: "document\.relabelled",/);
  assert.ok(relabel.indexOf("requireDocumentAccess(") < relabel.indexOf("prisma.document.updateMany("));
});

test("the form: a dropdown of the workspace's types and of the customer's quotes — one target, and no free text", () => {
  const fields = code("src/components/DocumentUploadFields.tsx");
  assert.match(fields, /<select name="label" defaultValue="" className="input h-9 text-sm">/);
  assert.doesNotMatch(fields, /<input[^>]*name="label"|datalist/, "a dropdown, not a box to type in");
  // The quote REPLACES the customer as the target: never both in one form.
  assert.match(fields, /\{quoteId \? <input type="hidden" name="quoteId" value=\{quoteId\} \/> : contactId \? <input type="hidden" name="contactId" value=\{contactId\} \/> : null\}/);
  const panel = code("src/components/DocumentsPanel.tsx");
  assert.match(panel, /<DocumentUploadFields types=\{types\} quotes=\{fileAgainst\} contactId=\{contactId\} \/>/);
  assert.doesNotMatch(panel, /\{contactId && <input type="hidden" name="contactId"/, "the panel no longer adds the customer itself");
  // A quote a revision replaced is not offered.
  assert.match(panel, /\.filter\(\(group\) => !group\.superseded\)\.map\(\(group\) => \(\{ id: group\.id, label: `Q-\$\{group\.number\} \(\$\{group\.status\}\)` \}\)\)/);
  // The label leads on the list; a system tag cannot be relabelled from the row.
  assert.match(panel, /\{chosen \?\? doc\.fileName\}/);
  assert.match(panel, /\{isPersonLabel\(doc\.tag\) && \(\s*<ModalTrigger/);
});

test("the owner edits the list in Settings, and only the owner", () => {
  const settings = code("src/app/actions/settings.ts");
  const save = settings.slice(settings.indexOf("export async function saveDocumentTypes("), settings.indexOf("export async function saveQuoteDefaults("));
  assert.match(save, /await requireTenantOwner\(\);/);
  assert.ok(save.indexOf("requireTenantOwner()") < save.indexOf("putSetting("));
  assert.match(save, /await putSetting\(DOCUMENT_TYPES_KEY, raw\.trim\(\) \? parseDocumentTypes\(raw\)\.join\("\\n"\) : ""\);/);
  const page = code("src/app/(app)/settings/page.tsx");
  assert.match(page, /title="Document types"/);
  assert.match(page, /action=\{saveDocumentTypes\}/);
});
