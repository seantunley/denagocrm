import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseDocument } from "../src/lib/doceditor/model";
import { renderDocumentHtml, renderSigningSheets, type RenderCtx } from "../src/lib/doceditor/serialize";
import { showcaseQuoteTemplate } from "../src/lib/doceditor/standardTemplates";
import { ACCEPTANCE_GEOMETRY } from "../src/lib/doceditor/showcaseRender";
import { freezeDocumentGlobals, freezeVehicleShowcase } from "../src/lib/signing/freezeDocument";
import {
  modelName,
  parseVehicleSpecs,
  primaryVehicleProductId,
  readShowcase,
  showcaseFromProduct,
} from "../src/lib/docbuilder/vehicleShowcase";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const line = (over: Partial<{ productId: string | null; kind: string; sortOrder: number; optional: boolean; selected: boolean }>) => ({
  qty: 1, unitPriceCents: 100, productId: null, kind: "product", sortOrder: 0, optional: false, selected: true, ...over,
});

function ctx(vars: Record<string, unknown>, tokens: Record<string, string> = {}): RenderCtx {
  return {
    tokens: {
      "quote.number": "Q-1042", "quote.date": "29 Sep 2026", "quote.validUntil": "13 Oct 2026",
      "quote.subtotal": "R 205 652,17", "quote.vat": "R 30 847,83", "quote.total": "R 236 500,00",
      "customer.name": "Jane Buyer", "customer.phone": "082 000 0000", "customer.email": "jane@example.com",
      "company.name": "Denago Cape Town", "company.phone": "021 000 0000", "company.email": "sales@example.com",
      "company.website": "denago.example", "company.address": "Maitland, Cape Town", "company.instagram": "@denago",
      preparedBy: "Sam Seller", vehicle: "Denago EV Rover XL",
      ...tokens,
    },
    items: [{ cells: [{ value: "Denago EV Rover XL — White" }, { value: "1" }, { value: "R 235 000,00" }, { value: "R 235 000,00" }] }],
    vars,
    bound: true,
  };
}

test("the primary vehicle is the first charged catalogue line, not an accessory or a declined option", () => {
  assert.equal(primaryVehicleProductId([
    line({ productId: "acc", kind: "accessory", sortOrder: 0 }),
    line({ productId: "declined", optional: true, selected: false, sortOrder: 1 }),
    line({ productId: "rover", sortOrder: 3 }),
    line({ productId: "scout", sortOrder: 2 }),
  ]), "scout");
  assert.equal(primaryVehicleProductId([line({ productId: null }), line({ kind: "service_plan", productId: "plan" })]), null,
    "no product line → null, so the caller falls back to the lead's product");
});

test("product showcase data: specs are validated, capped at four, and only data-URL photos survive", () => {
  const specs = parseVehicleSpecs([
    { icon: "seats", label: "4 SEATS", sub: "Comfortable seating" },
    { icon: "bogus", label: "64 KM" },
    { icon: "electric", label: "" },
    "junk",
    { icon: "premium", label: "A" }, { icon: "speed", label: "B" }, { icon: "battery", label: "C" },
  ]);
  assert.deepEqual(specs.map((s) => s.label), ["4 SEATS", "64 KM", "A", "B"]);
  assert.equal(specs[1].icon, "premium", "an unknown icon falls back rather than failing");
  assert.equal(parseVehicleSpecs(null).length, 0);

  const data = showcaseFromProduct({ name: "Denago EV Rover XL", description: null, showcaseTagline: null, showcaseSpecs: null }, "https://evil.example/x.png");
  assert.equal(data.image, null, "a non-embedded link is never rendered");
  assert.equal(readShowcase({ showcase: { name: "" } }), null);
  assert.equal(modelName("Denago EV Rover XL", "DENAGO EV"), "Rover XL");
  assert.equal(modelName("Scout 2", "DENAGO EV"), "Scout 2");
});

test("the showcase renders THIS quote's model with its photo embedded as a data URL", () => {
  const doc = showcaseQuoteTemplate();
  const showcase = showcaseFromProduct({
    name: "Denago EV Rover XL",
    description: "Lifted, forward-facing four-seater built for estates.",
    showcaseTagline: "Lifted 4-seater",
    showcaseSpecs: [{ icon: "seats", label: "4 SEATS", sub: "Comfortable seating" }, { icon: "range", label: "64 KM", sub: "Typical range" }],
  }, PNG);
  const html = renderDocumentHtml(doc, ctx({ showcase }), "data:image/png;base64,AAAA");
  assert.match(html, />Rover XL</);
  assert.match(html, /Lifted 4-seater/);
  assert.match(html, /4 SEATS/);
  assert.ok(html.includes(`src="${PNG}"`), "the vehicle photo is embedded inline");
  assert.match(html, /Q-1042/);
  assert.match(html, /R 236 500,00/);
  assert.match(html, /Denago Cape Town/);
  assert.doesNotMatch(html, /\{\{/, "no unresolved merge token reaches the customer");

  // A different quote, a different model.
  const scout = renderDocumentHtml(doc, ctx({ showcase: showcaseFromProduct({ name: "Denago EV Scout 2", description: null, showcaseTagline: null, showcaseSpecs: null }, null) }));
  assert.match(scout, />Scout 2</);
  assert.doesNotMatch(scout, />Rover XL</);
});

test("no product, photo or specs: those parts are hidden — no broken image, no tokens", () => {
  const doc = showcaseQuoteTemplate();
  const nameOnly = renderDocumentHtml(doc, ctx({}, { vehicle: "Denago EV Nomad" }));
  assert.match(nameOnly, />Nomad</, "falls back to the quote's vehicle name");
  assert.doesNotMatch(nameOnly, /<img[^>]+alt="Denago EV Nomad"/);
  assert.doesNotMatch(nameOnly, /Vehicle photo of the quoted model/, "the design-time placeholder never reaches a real quote");
  assert.doesNotMatch(nameOnly, /Model name/);

  const nothing = renderDocumentHtml(doc, ctx({}, { vehicle: "—", "company.instagram": "", "company.address": "" }));
  assert.doesNotMatch(nothing, /\{\{/);
  assert.doesNotMatch(nothing, /Model name|Vehicle photo of the quoted model/);
  assert.match(nothing, /Jane Buyer/, "the rest of the quote still renders");
});

test("the showcase layout keeps a customer signature and date on the acceptance card", () => {
  const doc = showcaseQuoteTemplate();
  const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
  assert.ok(parsed, "the layout is a valid stored document");
  const customer = parsed.recipients.find((r) => r.party === "customer");
  assert.ok(customer && customer.role === "signer");

  const page = parsed.pages[0];
  const sig = page.overlayFields.find((f) => f.kind === "signature");
  const date = page.overlayFields.find((f) => f.kind === "date");
  assert.ok(sig && date);
  assert.equal(sig.recipientId, customer.id);
  assert.equal(date.recipientId, customer.id);
  assert.equal(sig.anchor.mode, "page", "only page-anchored fields are placed by the signing flow");

  const card = page.floatingBlocks.find((fb) => fb.block.type === "acceptance");
  assert.ok(card);
  const g = ACCEPTANCE_GEOMETRY;
  const cardH = g.pad * 2 + g.titleH + g.textH + g.nameRowH + g.sigRowH + g.dateRowH;
  for (const f of [sig, date]) {
    assert.ok(f.anchor.x >= card.x && f.anchor.x + f.width <= card.x + card.width, `${f.kind} sits within the card horizontally`);
    assert.ok(f.anchor.y >= card.y && f.anchor.y + f.height <= card.y + cardH, `${f.kind} sits within the card vertically`);
  }
  assert.ok(card.y + cardH <= 1123 - parsed.style.margin, "the card is on the sheet");
});

test("a sent quote keeps its vehicle: editing the product changes neither the signer view nor the sealed PDF", () => {
  const PNG_B = "data:image/png;base64,QkJCQkJCQkI=";
  const original = showcaseFromProduct({
    name: "Denago EV Rover XL", description: "Original description.", showcaseTagline: "Original tagline",
    showcaseSpecs: [{ icon: "seats", label: "4 SEATS", sub: "Comfortable seating" }],
  }, PNG);
  const edited = showcaseFromProduct({
    name: "Denago EV Rover XL", description: "EDITED description.", showcaseTagline: "EDITED tagline",
    showcaseSpecs: [{ icon: "seats", label: "9 SEATS", sub: "EDITED" }],
  }, PNG_B);

  // SEND: what service.ts stores as snapshotJson — globals frozen, then the vehicle.
  const sent = freezeVehicleShowcase(freezeDocumentGlobals(showcaseQuoteTemplate(), { "company.name": "Denago Cape Town" }), original);
  const snapshot = parseDocument(JSON.parse(JSON.stringify(sent)));
  assert.ok(snapshot, "the frozen snapshot is a valid stored document");
  assert.equal(JSON.stringify(snapshot).split(PNG).length - 1, 1, "the photo is stored once — the details block carries no copy");

  // EDIT the product, then render the SAME snapshot. Even a context carrying the
  // edited product (the worst case) must not reach the document.
  const live = ctx({ showcase: edited });
  const signerView = renderSigningSheets(snapshot, live).pages.join("\n");
  const sealedPdf = renderDocumentHtml(snapshot, live, undefined, {
    stampedFields: [{ page: 0, x: 500, y: 930, width: 200, height: 38, kind: "signature", image: PNG, label: "Jane Buyer" }],
  });
  for (const [surface, html] of [["signer view", signerView], ["sealed PDF", sealedPdf]] as const) {
    assert.match(html, /Original tagline/, `${surface}: original tagline`);
    assert.match(html, /Original description\./, `${surface}: original description`);
    assert.match(html, /4 SEATS/, `${surface}: original specs`);
    assert.ok(html.includes(`src="${PNG}"`), `${surface}: original photo`);
    assert.doesNotMatch(html, /EDITED|9 SEATS/, `${surface}: nothing from the edited product`);
    assert.ok(!html.includes(PNG_B), `${surface}: not the new photo`);
  }

  // Sent with NO vehicle: a product added to the quote later cannot appear.
  const none = parseDocument(JSON.parse(JSON.stringify(freezeVehicleShowcase(showcaseQuoteTemplate(), null))))!;
  const later = renderDocumentHtml(none, live);
  assert.doesNotMatch(later, /EDITED|9 SEATS|>Rover XL</);
  assert.ok(!later.includes(PNG_B));
});

test("band photos and the vehicle-photo fade: rendered under an overlay, and carried in the snapshot", () => {
  const HEADER = "data:image/jpeg;base64,SEVBREVS";
  const FOOTER = "data:image/jpeg;base64,Rk9PVEVS";
  const doc = showcaseQuoteTemplate();
  const blocks = [...doc.pages[0].rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)), ...doc.pages[0].floatingBlocks.map((f) => f.block)];
  for (const b of blocks) {
    if (b.type === "showcaseHeader") b.bgImage = HEADER;
    if (b.type === "footerBand") b.bgImage = FOOTER;
  }
  // Sent: the band photos travel inside the snapshot's own blocks.
  const snapshot = parseDocument(JSON.parse(JSON.stringify(freezeVehicleShowcase(doc, showcaseFromProduct(
    { name: "Denago EV Rover XL", description: null, showcaseTagline: null, showcaseSpecs: null }, PNG)))))!;
  const html = renderSigningSheets(snapshot, ctx({})).pages.join("\n");
  for (const img of [HEADER, FOOTER]) {
    // Single-quoted: a double quote would end the style="…" attribute it sits in.
    assert.ok(html.includes(`rgba(2,6,23,.38)),url('${img}')`), `${img} is rendered under the darkening overlay`);
  }
  assert.doesNotMatch(html, /style="[^"]*url\("/, "no double quote inside a style attribute");
  assert.match(html, /object-fit:cover;object-position:center;-webkit-mask-image:linear-gradient\(to right,transparent/, "a filled photo fades in from the left");

  const contained = showcaseQuoteTemplate();
  for (const b of contained.pages[0].rows.flatMap((r) => r.columns.flatMap((c) => c.blocks))) if (b.type === "vehicleShowcase") b.imageFit = "contain";
  const plain = renderDocumentHtml(contained, ctx({ showcase: showcaseFromProduct({ name: "Scout", description: null, showcaseTagline: null, showcaseSpecs: null }, PNG) }));
  assert.doesNotMatch(plain, /mask-image/, "a contained cut-out is not faded");
});

test("the send and snapshot-render paths are wired to the frozen vehicle", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (f: string) => readFileSync(path.join(root, f), "utf8");
  const service = read("src/lib/signing/service.ts");
  assert.match(service, /const frozenDoc = await freezeQuoteShowcase\(/, "send time freezes the vehicle into the snapshot");
  assert.match(service, /snapshotJson: frozenDoc/);
  const render = read("src/lib/signing/render.ts");
  for (const fn of ["renderRequestDocHtml", "renderRequestSigningSheets"]) {
    const body = render.slice(render.indexOf(`function ${fn}`), render.indexOf("\n}\n", render.indexOf(`function ${fn}`)));
    assert.match(body, /liveVehicle: false/, `${fn} must not read the live product`);
  }
  assert.match(read("src/lib/signing/complete.ts"), /bindCtx\([^)]*\{ liveVehicle: false \}\)/, "the sealed PDF must not read the live product");
});

test("design-time preview shows placeholders, and poisoned colours never break out", () => {
  const doc = showcaseQuoteTemplate();
  const preview = renderDocumentHtml(doc, null);
  assert.match(preview, /Model name/);
  assert.match(preview, /\{\{quote\.number\}\}/, "unbound: the designer sees what binds where");

  const poisoned = JSON.parse(JSON.stringify(doc));
  const BREAKOUT = `#fff" onmouseover="alert(1)" x="`;
  const paint = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(paint);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (/^(accent|color|bg|ink)$/.test(k) && typeof v === "string") (node as Record<string, unknown>)[k] = BREAKOUT;
        else if (k === "bgImage") (node as Record<string, unknown>)[k] = `data:image/png;base64,AA");background:url("https://evil.example`;
        else paint(v);
      }
    }
  };
  paint(poisoned);
  for (const model of [parseDocument(poisoned)!, poisoned]) {
    const sheets = renderSigningSheets(model, ctx({}));
    const html = sheets.pages.join("\n");
    assert.doesNotMatch(html, /onmouseover|alert\(1\)|evil\.example/);
  }

  const code = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/lib/doceditor/showcaseRender.ts"), "utf8");
  const raw = [...code.matchAll(/\$\{(?!cssColor)[^}]*\b(accent|headerBg|headerColor|ink|bg)\b[^}]*\}/g)];
  assert.deepEqual(raw.map((m) => m[0]), [], "every colour in the showcase renderer goes through cssColor");
});
