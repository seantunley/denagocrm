import assert from "node:assert/strict";
import { test, after } from "node:test";
import Module, { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { blankDocument, newBlock, newColumn, newPage, newRow } from "../src/lib/doceditor/factory";
import type { DocumentBlock, DocumentModel } from "../src/lib/doceditor/model";

/**
 * A custom document's Finalise renders through renderModelToPdf, not through the
 * template path that #671 taught to embed uploaded images. Uploaded images are
 * PRIVATE stored files: printed as a raw link they are broken in the filed PDF
 * (the renderer has no session), and an image ref from another workspace must
 * not be printed at all.
 *
 * Behavioural: the REAL generate.ts → renderGlobals.embedDocImages → storedImage
 * → storage.readFile chain runs, with only the database, company profile, auth
 * and the Chromium step stubbed. htmlToPdf is replaced by a capture, so what is
 * asserted is exactly the HTML the filed PDF is printed from.
 */

// Local uploads live under <cwd>/storage/uploads, read at module load — so the
// modules are loaded from a scratch directory, never the repository.
const scratch = mkdtempSync(path.join(tmpdir(), "customdoc-images-"));
const uploads = path.join(scratch, "storage", "uploads");
mkdirSync(uploads, { recursive: true });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
writeFileSync(path.join(uploads, "own-photo.png"), PNG);
const OWN_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;
// Another workspace's private blob. With a private-store token configured the
// owner check runs on the pathname before any network call.
const FOREIGN_REF = "https://abc123.private.blob.vercel-storage.com/uploads/tenant_b/photo.png";
process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "test-token-never-used-for-a-request";
const WORKSPACE_LOGO = "data:image/png;base64,QUNNRUxPR08=";

let captured = "";
let acting: string | null = "tenant_a";
const stubs: Record<string, unknown> = {
  "@/lib/db": { prisma: {}, basePrisma: {} },
  "@/lib/docbuilder/store": { getBuilderTemplate: async () => null, getLiveBuilderTemplate: async () => null },
  "@/lib/docbuilder/merge": { buildQuoteContext: () => null, buildJobCardContext: () => null, documentGlobalTokens: () => ({}) },
  "@/lib/quoteBillTo": { loadBillToFleet: async () => null },
  "@/lib/companyProfile": {
    getCompanyProfile: async () => ({ name: "Acme Carts", logoUrl: WORKSPACE_LOGO }),
    companyTokens: () => ({ "company.name": "Acme Carts" }),
  },
  "@/lib/customDocs": { htmlToPdf: async (html: string) => { captured = html; return Buffer.from("%PDF"); } },
  "@/lib/auth": { getCurrentUser: async () => null, getActiveTenantId: async () => acting },
  "@/lib/tenantScope": { currentTenantScope: () => (acting ? { tenantId: acting, system: false } : null) },
  "@/lib/tenantBrand": { brandForTenant: async () => ({}), brandLogoAsset: () => null, brandLogoUrl: () => null },
  "@/lib/tenantOrigin": { tenantOrigin: async () => "" },
};
type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request in stubs) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const repo = process.cwd();
process.chdir(scratch);
const generate = createRequire(import.meta.url)("../src/lib/doceditor/generate.ts") as typeof import("../src/lib/doceditor/generate");
process.chdir(repo);
after(() => rmSync(scratch, { recursive: true, force: true }));

function documentWith(...srcs: string[]): DocumentModel {
  const images = srcs.map((src) => ({ ...newBlock("image"), src }) as DocumentBlock);
  return { ...blankDocument("Handover"), pages: [newPage([newRow([newColumn(100, [newBlock("banner"), ...images])])])] };
}

test("Finalise embeds the document's own uploaded image as a data URL, not a storage link", async () => {
  captured = "";
  const pdf = await generate.renderModelToPdf(documentWith("own-photo.png"), null, "tenant_a");
  assert.equal(pdf.toString(), "%PDF");
  assert.ok(captured.includes(`src="${OWN_DATA_URL}"`), "the uploaded image is embedded");
  assert.ok(!captured.includes("own-photo.png"), "no raw storage ref reaches the PDF");
  assert.ok(captured.includes(WORKSPACE_LOGO), "the workspace logo prints on the banner");
});

test("an image stored by another workspace is dropped, not printed", async () => {
  captured = "";
  await generate.renderModelToPdf(documentWith("own-photo.png", FOREIGN_REF), null, "tenant_a");
  assert.ok(captured.includes(OWN_DATA_URL), "the document's own image still prints");
  assert.ok(!captured.includes("abc123.private.blob"), "the foreign ref is not linked");
  assert.ok(!captured.includes("/api/stored?ref="), "…nor proxied");
});

test("a document with no owner is checked against the acting workspace", async () => {
  acting = "tenant_a";
  const html = await generate.renderCustomDocumentHtml(documentWith(FOREIGN_REF), null, null);
  assert.ok(!html.includes("abc123.private.blob"));
});
