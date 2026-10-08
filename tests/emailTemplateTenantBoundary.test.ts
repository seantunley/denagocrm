import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";

/*
 * Review of #806: an email layout was guarded by `isTenantOwner()` alone — which
 * proves the caller owns THEIR workspace, not that the `email:…` row they named
 * belongs to it. The lookup is by id, so workspace A's owner holding one of B's
 * template ids could open, save over, publish, restore and preview B's email.
 *
 * The fix is at the one door every by-id read uses, getBuilderTemplate. This
 * runs the real function against rows of two workspaces.
 */

type Row = { id: string; key: string; tenantId: string | null; deletedAt: Date | null; data: unknown };
const rows: Row[] = [
  { id: "a_frame", key: "email:frame", tenantId: "tenant_a", deletedAt: null, data: {} },
  { id: "b_frame", key: "email:frame", tenantId: "tenant_b", deletedAt: null, data: {} },
  { id: "b_quote_email", key: "email:quote", tenantId: "tenant_b", deletedAt: null, data: {} },
  { id: "orphan_email", key: "email:invite", tenantId: null, deletedAt: null, data: {} },
  { id: "a_quote_layout", key: "quote", tenantId: "tenant_a", deletedAt: null, data: {} },
];
let active: string | null = "tenant_a";
let sessionBroken = false;

type Loader = (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/docbuilder/store.ts")) {
    // The by-id read exactly as the store issues it: by id alone, no tenant in the query.
    if (request === "@/lib/db") {
      return { prisma: { docBuilderTemplate: { findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null } } };
    }
    if (request === "@/lib/auth") {
      return { getActiveTenantId: async () => { if (sessionBroken) throw new Error("no session"); return active; } };
    }
    if (request === "@/lib/docModuleAccess") return { docKeyEnabled: async () => true };
    if (request === "@/lib/modules/enabled") return { isModuleEnabled: async () => true };
    if (request === "@/lib/docTemplateStore") return { getDocTemplateText: async () => ({ sections: {} }) };
    if (request.startsWith("@/lib/doceditor/")) return {};
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const store = createRequire(import.meta.url)("../src/lib/docbuilder/store.ts") as typeof import("../src/lib/docbuilder/store");
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("an email layout exists only for the workspace that owns it", async () => {
  active = "tenant_a";
  assert.equal((await store.getBuilderTemplate("a_frame"))?.id, "a_frame", "its own email opens");
  assert.equal(await store.getBuilderTemplate("b_frame"), null, "another workspace's frame is simply not there");
  assert.equal(await store.getBuilderTemplate("b_quote_email"), null, "nor its emails");
  active = "tenant_b";
  assert.equal((await store.getBuilderTemplate("b_quote_email"))?.id, "b_quote_email");
  assert.equal(await store.getBuilderTemplate("a_frame"), null);
});

test("it fails closed: no workspace, a broken session, or an email row with no tenant", async () => {
  active = null;
  assert.equal(await store.getBuilderTemplate("a_frame"), null, "no active workspace");
  active = "tenant_a";
  sessionBroken = true;
  assert.equal(await store.getBuilderTemplate("a_frame"), null, "the session can't be read");
  sessionBroken = false;
  assert.equal(await store.getBuilderTemplate("orphan_email"), null, "an email with no tenant is nobody's");
});

test("print layouts are untouched by this rule", async () => {
  active = "tenant_a";
  assert.equal((await store.getBuilderTemplate("a_quote_layout"))?.id, "a_quote_layout");
});

test("every path to an email goes through that door, and the preview reads only the acting workspace", () => {
  // The paths the review named: open, autosave, image upload, publish, restore, history, export, preview.
  const editor = src("src/app/actions/doceditor.ts");
  const builder = src("src/app/actions/docbuilder.ts");
  assert.ok((editor.match(/await getBuilderTemplate\(/g) ?? []).length >= 3, "save, upload and open");
  assert.ok((builder.match(/await getBuilderTemplate\(/g) ?? []).length >= 6, "publish, reset, restore, history, rename, delete");
  for (const file of [editor, builder]) {
    assert.doesNotMatch(file, /docBuilderTemplate\.findUnique\(/, "no by-id read that skips the door");
  }
  for (const route of ["src/app/api/email-preview/[id]/route.ts", "src/app/api/pdf/doc-editor/[id]/route.ts", "src/app/api/doc-editor/[id]/export/route.ts", "src/app/doc-editor/[id]/page.tsx"]) {
    assert.match(src(route), /getBuilderTemplate\(id\)/, route);
  }
  const preview = src("src/app/api/email-preview/[id]/route.ts");
  assert.match(preview, /const tenantId = await getActiveTenantId\(\);\s*if \(!tenantId \|\| template\.tenantId !== tenantId\) return new Response\("Not found", \{ status: 404 \}\);/);
  assert.match(preview, /where: \{ tenantId, key: otherKey, deletedAt: null \}/, "the companion frame/body is this workspace's, named in the query");
  assert.doesNotMatch(preview, /template\.tenantId \?\?/, "the workspace never comes from the row");
  const page = src("src/app/doc-editor/[id]/page.tsx");
  assert.match(page, /if \(!tenantId \|\| template\.tenantId !== tenantId\) notFound\(\);/);
});
