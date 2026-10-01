import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newBlock, newColumn, newPage, newRow, blankDocument } from "../src/lib/doceditor/factory";
import { renderDocumentHtml, type RenderCtx } from "../src/lib/doceditor/serialize";
import type { DocumentBlock, DocumentModel } from "../src/lib/doceditor/model";
import { checkDocImage, DOC_IMAGE_MAX_BYTES } from "../src/lib/doceditor/imageUpload";

const root = path.resolve(import.meta.dirname, "..");
const shipped = (rel: string) => readFileSync(path.join(root, rel), "utf8");

function docWith(block: DocumentBlock): DocumentModel {
  return { ...blankDocument("T"), pages: [newPage([newRow([newColumn(100, [block])])])] };
}
const ctx = (over: Partial<NonNullable<RenderCtx>> = {}): RenderCtx =>
  ({ tokens: { "company.name": "Acme Carts" }, items: [], vars: {}, bound: false, ...over });

const TENANT_LOGO = "data:image/png;base64,QUNNRQ==";
const DENAGO_LOGO = "data:image/png;base64,REVOQUdP";

// ── 1. tenant logo ─────────────────────────────────────────────────

test("the banner prints the workspace logo from the context, not the built-in one", () => {
  const html = renderDocumentHtml(docWith(newBlock("banner")), ctx({ logo: TENANT_LOGO }), DENAGO_LOGO);
  assert.ok(html.includes(TENANT_LOGO), "the tenant's logo is embedded");
  assert.ok(!html.includes(DENAGO_LOGO), "the built-in logo is not");
  assert.match(html, /alt="Acme Carts"/);
});

test("with no workspace logo on the context the passed fallback still prints", () => {
  const html = renderDocumentHtml(docWith(newBlock("banner")), ctx(), DENAGO_LOGO);
  assert.ok(html.includes(DENAGO_LOGO));
});

test("the Denago logo path is no longer hard-coded as the banner's only source", () => {
  for (const rel of ["src/lib/doceditor/serialize.ts", "src/components/doceditor/BlockView.tsx"]) {
    assert.doesNotMatch(shipped(rel), /denago-logo-email/, `${rel} must not hard-code the Denago logo`);
  }
  // Every live render path resolves the workspace logo onto the context — which is
  // how the callers that still pass the built-in mark (quotePrintDocument) get it too.
  for (const rel of ["src/lib/signing/render.ts", "src/lib/doceditor/generate.ts"]) {
    assert.match(shipped(rel), /const logo = await documentLogo\(/, `${rel} resolves the workspace logo`);
    assert.match(shipped(rel), /bound: true, logo, regional \}/, `${rel} puts it on the context`);
  }
  // …and the canvas is given the same one.
  assert.match(shipped("src/app/doc-editor/[id]/page.tsx"), /documentLogo\(company\.logoUrl\)/);
});

// ── 2. image upload ────────────────────────────────────────────────

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v])));
const PNG = bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0);
const WEBP = bytes("RIFF", 0, 0, 0, 0, "WEBP");

test("PNG, JPEG and WebP are accepted, typed from their bytes", () => {
  assert.deepEqual(checkDocImage(1000, PNG), { ok: true, mime: "image/png", ext: "png" });
  assert.deepEqual(checkDocImage(1000, JPEG), { ok: true, mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(checkDocImage(1000, WEBP), { ok: true, mime: "image/webp", ext: "webp" });
});

test("SVG is refused — it can carry script into a signing page or PDF", () => {
  for (const svg of [bytes('<svg xmlns="http://www.w3.org/2000/svg">'), bytes('<?xml version="1.0"?><svg')]) {
    const result = checkDocImage(500, svg);
    assert.equal(result.ok, false);
  }
  assert.equal(checkDocImage(500, bytes("GIF89a", 0, 0, 0, 0, 0, 0)).ok, false, "anything off the allow-list is refused");
});

test("an image over 5 MB is refused, and an empty file too", () => {
  const over = checkDocImage(DOC_IMAGE_MAX_BYTES + 1, PNG);
  assert.equal(over.ok, false);
  assert.match(!over.ok ? over.error : "", /5 MB/);
  assert.equal(checkDocImage(DOC_IMAGE_MAX_BYTES, PNG).ok, true, "exactly the cap is fine");
  assert.equal(checkDocImage(0, PNG).ok, false);
});

test("the upload action is permission-gated, checks the bytes, and files under the template's workspace", () => {
  const code = shipped("src/app/actions/doceditor.ts");
  const start = code.indexOf("export async function uploadDocEditorImage(");
  assert.notEqual(start, -1);
  const body = code.slice(start, code.indexOf("\n}\n", start));
  assert.match(body, /requirePermission\("docbuilder\.manage"\)/);
  assert.match(body, /checkDocImage\(file\.size/);
  assert.match(body, /saveFile\(bytes, `image\.\$\{type\.ext\}`, type\.mime, tenantId\)/, "stored with the SNIFFED type, not the browser's");
  assert.match(body, /template \? template\.tenantId : await actingOwnerTenantId\(\)/);
});

test("an uploaded (private) image is never printed as its raw storage link", () => {
  const ref = "https://abc123.private.blob.vercel-storage.com/uploads/tenant_a/photo.png";
  const image = { ...newBlock("image"), src: ref } as DocumentBlock;
  const html = renderDocumentHtml(docWith(image), ctx());
  assert.ok(!html.includes(`src="${ref}"`), "raw private link must not be emitted");
  assert.match(html, /src="\/api\/stored\?ref=/, "an un-embedded ref goes through the signed-in proxy");

  const embedded = { ...newBlock("image"), src: TENANT_LOGO } as DocumentBlock;
  assert.ok(renderDocumentHtml(docWith(embedded), ctx()).includes(`src="${TENANT_LOGO}"`), "an embedded image prints as-is");

  const hostile = { ...newBlock("image"), src: "javascript:alert(1)" } as DocumentBlock;
  assert.doesNotMatch(renderDocumentHtml(docWith(hostile), ctx()), /javascript:/);
});

test("every render path embeds uploaded images before rendering", () => {
  assert.match(shipped("src/lib/doceditor/generate.ts"), /embedDocImages\(read\.doc, tpl\.tenantId\)/);
  const render = shipped("src/lib/signing/render.ts");
  assert.match(render, /embedDocImages\(parsed, req\.tenantId\)/);
  assert.match(render, /embedDocImages\(doc\)/);
  assert.match(shipped("src/lib/signing/complete.ts"), /embedDocImages\(doc, req\.tenantId\)/);
});
