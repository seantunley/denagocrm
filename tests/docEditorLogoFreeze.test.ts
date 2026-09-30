import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { classifyLogoUrl } from "../src/lib/doceditor/logoSource";
import { blankDocument, newBlock, newColumn, newPage, newRow } from "../src/lib/doceditor/factory";
import { renderDocumentHtml } from "../src/lib/doceditor/serialize";

/**
 * A document never links its logo from an outside host. Hot-linking one made
 * the customer's signing page contact a third party, and a "frozen" signed
 * document could change or lose its logo whenever that host did. Fetching it
 * instead would mean the server fetching an admin-typed URL (SSRF). So an
 * outside link is replaced by the tenant's UPLOADED brand logo, or the built-in
 * one — at render time and, for signing, at freeze time.
 */

const root = path.resolve(import.meta.dirname, "..");
const shipped = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("outside links are classified external; our own shapes are not", () => {
  for (const url of ["https://cdn.example.com/logo.png", "http://intranet/logo.png", "https://169.254.169.254/latest", "//evil.example/x.png", "javascript:alert(1)"]) {
    assert.equal(classifyLogoUrl(url).kind, "external", url);
  }
  assert.deepEqual(classifyLogoUrl("https://acme.example/api/brand/logo/tenant_a?a=logo-17.png"), { kind: "brand", tenantId: "tenant_a", asset: "logo-17.png" });
  assert.deepEqual(classifyLogoUrl("https://crm.denagocpt.co.za/branding/denago-logo-email.png"), { kind: "public", file: "denago-logo-email.png" });
  assert.equal(classifyLogoUrl("https://abc.private.blob.vercel-storage.com/uploads/t/x.png").kind, "stored");
  assert.equal(classifyLogoUrl("data:image/png;base64,QQ==").kind, "data");
  assert.equal(classifyLogoUrl("").kind, "none");
  // Path tricks cannot turn a brand route into another file.
  assert.equal(classifyLogoUrl("/api/brand/logo/../../etc/passwd").kind, "external");
  assert.equal(classifyLogoUrl("/branding/../.env").kind, "external");
});

// ── behaviour of the server helpers, with their I/O stubbed ─────────

const BRAND_BYTES = Buffer.from("BRANDLOGO");
const calls = { managed: [] as string[], fetches: 0 };
let brandLogoRef: string | null = "branding/tenant_a/logo-17.png";
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/auth": { getActiveTenantId: async () => "tenant_a", getCurrentUser: async () => null },
  "@/lib/storage": {
    isStoredFileRef: (ref: string) => /blob\.vercel-storage\.com/.test(ref),
    readManagedBlob: async (ref: string) => { calls.managed.push(ref); return BRAND_BYTES; },
  },
  "@/lib/storedImage": { embedStoredImage: async () => null },
  "@/lib/tenantScope": { currentTenantScope: () => ({ tenantId: "tenant_a", system: false }) },
  "@/lib/tenantOrigin": { tenantOrigin: async () => "https://acme.example" },
  // tenantBrand's own import: no database is ever reached from this test.
  "./db": { basePrisma: {}, prisma: {} },
};
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/tenantBrand") {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, brandForTenant: async (tenantId: string) => ({ tenantId, logoRef: brandLogoRef }) };
  }
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { calls.fetches += 1; throw new Error("no network in documents"); }) as typeof fetch;
const globals = createRequire(import.meta.url)("../src/lib/doceditor/renderGlobals.ts") as typeof import("../src/lib/doceditor/renderGlobals");
test.after(() => { globalThis.fetch = originalFetch; });

test("an outside logo renders as the tenant's uploaded brand logo, embedded — never the link", async () => {
  brandLogoRef = "branding/tenant_a/logo-17.png";
  const logo = await globals.documentLogo("https://cdn.example.com/logo.png");
  assert.equal(logo, `data:image/png;base64,${BRAND_BYTES.toString("base64")}`);
  assert.deepEqual(calls.managed.at(-1), "branding/tenant_a/logo-17.png");
  assert.equal(calls.fetches, 0, "the outside host is never contacted");
});

test("…and as the built-in logo when the tenant has no uploaded one", async () => {
  brandLogoRef = null;
  const logo = await globals.documentLogo("https://cdn.example.com/logo.png");
  assert.equal(logo, globals.defaultLogoDataUri());
  assert.doesNotMatch(logo ?? "", /cdn\.example\.com/);
});

test("at send time an outside logo is frozen as our immutable brand asset, or as the built-in logo", async () => {
  brandLogoRef = "branding/tenant_a/logo-17.png";
  assert.equal(await globals.freezableLogoUrl("https://cdn.example.com/logo.png"), "https://acme.example/api/brand/logo/tenant_a?a=logo-17.png");
  brandLogoRef = null;
  assert.equal(await globals.freezableLogoUrl("https://cdn.example.com/logo.png"), null);
  // Our own shapes are already frozen-safe and pass through unchanged.
  const ours = "https://acme.example/api/brand/logo/tenant_a?a=logo-9.png";
  assert.equal(await globals.freezableLogoUrl(ours), ours);
  assert.equal(await globals.freezableLogoUrl(null), null);
  assert.equal(calls.fetches, 0);
});

test("the send path freezes the logo through freezableLogoUrl", () => {
  const code = shipped("src/lib/signing/service.ts");
  const at = code.indexOf("const brand = frozenBrand(profile);");
  const frozenAt = code.indexOf("brand.logoUrl = await freezableLogoUrl(brand.logoUrl);");
  const storedAt = code.indexOf("brandJson: brand as object");
  assert.ok(at !== -1 && frozenAt > at && storedAt > frozenAt, "captured, then made frozen-safe, THEN stored on the request");
});

test("the renderer never prints a logo LINK, even one handed to it directly", () => {
  const doc = { ...blankDocument("T"), pages: [newPage([newRow([newColumn(100, [newBlock("banner")])])])] };
  const ctx = { tokens: { "company.name": "Acme Carts" }, items: [], vars: {}, logo: "https://cdn.example.com/logo.png" };
  const html = renderDocumentHtml(doc, ctx, "https://other.example/frozen.png");
  assert.doesNotMatch(html, /cdn\.example\.com|other\.example/);
  assert.match(html, /ACME CARTS/, "the company wordmark stands in");
});

// ── uploaded images on the printed quote ──────────────────────────

test("the printed quote embeds uploaded images on both the signed and the template path", () => {
  const code = shipped("src/lib/quotePrintDocument.ts");
  assert.match(code, /select: \{ id: true, snapshotJson: true, brandJson: true, tenantId: true \}/);
  assert.match(code, /embedDocImages\(parsed, request\.tenantId \?\? undefined\)/, "signed snapshot, owner-checked against the request");
  assert.match(code, /const doc = await embedDocImages\(read\.doc, template\.tenantId \?\? undefined\);/, "template path, owner-checked against the template");
  assert.match(code, /renderDocumentHtml\(doc, ctx, logoDataUri\(\)/, "and it is the embedded doc that is rendered");
  // The published-version split from #669 is kept.
  assert.match(code, /opts\.templateId \? await getBuilderTemplate\(templateId\) : await getLiveBuilderTemplate\(templateId\)/);
});
