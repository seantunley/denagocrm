import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { blankDocument, newRecipient, newOverlayField, uid } from "../src/lib/doceditor/factory";
import { documentSchema, type DocumentModel } from "../src/lib/doceditor/model";
import {
  hasSendReadyRecipients,
  remapTemplateSigningRecipients,
  resolvePartyRecipients,
  recipientLabel,
} from "../src/lib/signing/templateRecipients";
import {
  buildPortableDocument,
  portableDocumentSchema,
  externalImageCount,
} from "../src/lib/doceditor/portable";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function docWithRecipients(recipients: DocumentModel["recipients"]): DocumentModel {
  const doc = blankDocument("Quote");
  doc.recipients = recipients;
  return doc;
}

/**
 * A template is reused across records, so it cannot know the customer's name or
 * the sender's email — only WHICH PARTY signs where. Before parties existed a
 * recipient was always a literal person: sending threw them away, invented a
 * fresh pair, and worked out which signature block belonged to whom by
 * pattern-matching the names it had just discarded.
 */

test("a party recipient is send-ready without an email", () => {
  const doc = docWithRecipients([
    newRecipient({ name: "Denago", party: "denago" }),
    newRecipient({ name: "Customer", party: "customer" }),
  ]);
  assert.equal(hasSendReadyRecipients(doc), true, "the email arrives from the record at send time");

  // A literal person still needs one — nothing will fill it in for them.
  const literal = docWithRecipients([newRecipient({ name: "Anna", email: "not-an-email" })]);
  assert.equal(hasSendReadyRecipients(literal), false);
});

test("parties resolve to the real people, keeping the template's placement", () => {
  const denago = newRecipient({ name: "Sales manager", party: "denago" });
  const customer = newRecipient({ name: "Buyer", party: "customer" });
  const doc = docWithRecipients([denago, customer]);
  const field = newOverlayField("signature", { id: uid(), recipientId: denago.id, required: true, label: "For Denago" });
  doc.pages[0].overlayFields.push(field);

  const found = resolvePartyRecipients(doc, {
    denago: { name: "Sean Tunley", email: "sean@denago.co.za" },
    customer: { name: "Jane Buyer", email: "jane@example.com" },
  });

  assert.deepEqual(found, { denago: true, customer: true });
  assert.equal(doc.recipients[0].name, "Sean Tunley");
  assert.equal(doc.recipients[0].email, "sean@denago.co.za");
  assert.equal(doc.recipients[1].name, "Jane Buyer");
  // Identity survives, so the field placed against it still points at it.
  assert.equal(doc.recipients[0].id, denago.id);
  assert.equal(doc.pages[0].overlayFields[0].recipientId, denago.id);
});

test("a party recipient with no name of its own keeps the template's label", () => {
  const doc = docWithRecipients([newRecipient({ name: "Sales manager", party: "denago" })]);
  resolvePartyRecipients(doc, {
    denago: { name: "", email: "sales@denago.co.za" },
    customer: { name: "Jane", email: null },
  });
  assert.equal(doc.recipients[0].name, "Sales manager");
});

test("a declared party beats the name guess", () => {
  // recipientHint() reads /customer|client|buyer/ as the customer. A recipient
  // NAMED "Customer copy" but declared as Denago must go to Denago — the author
  // said so outright.
  const doc = docWithRecipients([newRecipient({ name: "Customer copy", party: "denago" })]);
  doc.pages[0].overlayFields.push(
    newOverlayField("signature", { id: uid(), recipientId: doc.recipients[0].id, required: true, label: "Sign" }),
  );
  const dealer = newRecipient({ name: "Denago", email: "sean@denago.co.za" });
  const buyer = newRecipient({ name: "Jane", email: "jane@example.com" });
  remapTemplateSigningRecipients(doc, [dealer, buyer]);
  assert.equal(doc.pages[0].overlayFields[0].recipientId, dealer.id, "the declared party decides, not the name");
});

test("the editor names a party rather than showing an empty recipient", () => {
  assert.equal(recipientLabel(newRecipient({ name: "", party: "denago" })), "Denago (whoever sends it)");
  assert.equal(recipientLabel(newRecipient({ name: "", party: "customer" })), "The customer");
  assert.equal(recipientLabel(newRecipient({ name: "Anna", party: "custom" })), "Anna");
  // The dropdown said "Unassigned" with nothing to pick, because an unnamed
  // template recipient rendered as an empty option.
  assert.equal(recipientLabel(newRecipient({ name: "", email: "", party: "custom" })), "Recipient");
});

test("Denago countersigns before the customer whatever order the blocks were added in", () => {
  const envelope = shipped("src/lib/signing/autoEnvelope.ts");
  assert.match(envelope, /recipient\.party === "denago"\)/, "the denago party must be hoisted to the front");
  assert.match(envelope, /ordering = "sequential"/, "…and the envelope must be sequential, or both go out at once");
});

/** Documents move between tenants now, so the export has to carry the model. */

test("a portable export round-trips through the importer", () => {
  const original = blankDocument("Terms of sale");
  original.recipients = [newRecipient({ name: "", party: "denago" })];
  const payload = buildPortableDocument({
    name: "Terms of sale",
    key: "quote",
    document: original,
    exportedAt: "2026-08-02T00:00:00.000Z",
  });

  // Over the wire and back, exactly as the file would travel.
  const parsed = portableDocumentSchema.safeParse(JSON.parse(JSON.stringify(payload)));
  assert.equal(parsed.success, true, "the importer must accept what the exporter wrote");
  if (!parsed.success) return;
  assert.equal(parsed.data.name, "Terms of sale");
  assert.equal(parsed.data.key, "quote");
  assert.equal(parsed.data.document.recipients[0].party, "denago", "the party must survive the trip");
  assert.deepEqual(documentSchema.parse(parsed.data.document), original);
});

test("the importer refuses anything that is not one of our exports", () => {
  for (const junk of [null, {}, { denagoDocument: 2, document: blankDocument("x") }, { document: { pages: [] } }]) {
    assert.equal(portableDocumentSchema.safeParse(junk).success, false, `${JSON.stringify(junk)} must not import`);
  }
});

test("images that will not travel are counted, not silently broken", () => {
  const doc = blankDocument("With images");
  const image = (src: string) => ({ id: uid(), type: "image" as const, src, alt: "", widthPct: 100, rounded: false, settings: {}, locked: false, hidden: false });
  doc.pages[0].rows[0].columns[0].blocks.push(
    image("https://blob.example.com/logo.png"),
    image("data:image/png;base64,AAAA"),
  );
  // A linked blob belongs to the tenant that uploaded it; the importer has no
  // right to read it, so the new tenant would get a broken image and no notice.
  assert.equal(externalImageCount(doc), 1);
});

/** Layout the designer can see and control. */

test("the total band never wraps its amount", () => {
  // A six-figure total breaking across two lines inside a coloured band is the
  // ugliest way this document can fail, and there was no control to prevent it.
  const code = shipped("src/lib/doceditor/serialize.ts");
  const band = code.slice(code.indexOf('case "totalBand"'), code.indexOf('case "terms"'));
  assert.equal((band.match(/white-space:nowrap/g) ?? []).length, 2, "label and amount both stay on one line");
  assert.match(band, /fontScale/, "and the type can be scaled down when the row is tight");
});

test("the type scale is applied once, not squared", () => {
  // totalBand computes its own point sizes from the scale because its type is
  // fixed in pt; the wrapper must not ALSO multiply it.
  const code = shipped("src/lib/doceditor/serialize.ts");
  assert.match(code, /b\.type !== "totalBand"/, "the wrapper must skip the block that scales itself");
});

test("alignment and size are offered on every block, not only narrow ones", () => {
  const panel = shipped("src/components/doceditor/PropertiesPanel.tsx");
  assert.match(panel, /fontScale: Number\(e\.target\.value\) \/ 100/, "a type size control must exist");
  assert.match(panel, /textAlignBtn\("left", "Left"\)/, "…and left/centre/right for the text inside");
  assert.match(panel, /w < 100 \|\| block\.type === "totalBand"/, "the band places itself even at full width");
});

test("the canvas shows where the paper actually ends", () => {
  // The page box only set a MIN height, so content that outgrew A4 just made a
  // taller sheet — the first anyone knew of the overflow was the preview
  // arriving with an extra page.
  const canvas = shipped("src/components/doceditor/Canvas.tsx");
  assert.match(canvas, /Math\.ceil\(height \/ sheet/, "the canvas must work out how many sheets it really needs");
  assert.match(canvas, /Page break/, "…and draw the boundary on the page");
});

test("the panel toggles change something on a desktop", () => {
  // `md:block` pinned both panels visible, so the toolbar buttons flipped a
  // value only the mobile drawer read: on a desktop they did nothing at all.
  const editor = shipped("src/components/doceditor/DocEditor.tsx");
  assert.doesNotMatch(editor, /md:static md:block/, "an unconditional md:block ignores the toggle");
  assert.match(editor, /paletteDocked \? "md:block" : "md:hidden"/);
  assert.match(editor, /inspectorDocked \? "md:block" : "md:hidden"/);
});

test("a date field is stamped, never typed", () => {
  // An editable date next to a signature lets a signer record a date they did
  // not sign on, and reads as one more empty box to fill in.
  const surface = shipped("src/app/signing/[token]/SignSurface.tsx");
  assert.doesNotMatch(surface, /<input type="date"/, "the signer must not be able to edit the signing date");
  assert.match(surface, /formatStamp\(value \|\| todayISO\(\)\)/);
});
