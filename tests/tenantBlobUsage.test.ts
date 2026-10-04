import assert from "node:assert/strict";
import { test } from "node:test";
import Module from "node:module";

/**
 * Tenant-fit audit 6.1: the console's storage figure was database-only, while
 * documents, photos and signed PDFs live in Blob storage. tenantBlobUsage sums
 * the workspace's own objects across both stores.
 */

type Blob = { pathname: string; size: number };
const STORES: Record<string, Blob[]> = {
  public: [
    { pathname: "uploads/legacy.pdf", size: 100 }, // founding, pre-namespace
    { pathname: "library/old.docx", size: 50 }, // founding, pre-namespace
    { pathname: "uploads/tenant_denago_cpt/a.png", size: 10 },
    { pathname: "uploads/tenant_b/b.png", size: 7 },
    { pathname: "backups/database/x.json", size: 999 }, // never a workspace's
  ],
  private: [
    { pathname: "uploads/tenant_b/c.pdf", size: 5 },
    // Same PATH in the other store: a second object, billed again — counts twice.
    { pathname: "uploads/tenant_b/b.png", size: 7 },
  ],
};
const calls: string[] = [];
const list = async ({ prefix, token }: { prefix: string; token: string }) => {
  calls.push(`${token}:${prefix}`);
  return { blobs: STORES[token].filter((b) => b.pathname.startsWith(prefix)), hasMore: false, cursor: undefined };
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "@vercel/blob") return { list };
  return realLoad.call(this, request, parent, isMain);
};
process.env.BLOB_READ_WRITE_TOKEN = "public";
process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "private";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { tenantBlobUsage } = require("../src/lib/storage") as typeof import("../src/lib/storage");

test("a workspace counts only its own namespace, every object in every store", async () => {
  calls.length = 0;
  // b.png (7) in public + c.pdf (5) and b.png (7) in private: three objects.
  assert.deepEqual(await tenantBlobUsage("tenant_b"), { bytes: 19, files: 3, truncated: false });
  assert.deepEqual(calls.sort(), ["private:uploads/tenant_b/", "public:uploads/tenant_b/"]);
});

test("one store configured under both settings is listed, and counted, once", async () => {
  process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "public";
  try {
    calls.length = 0;
    assert.deepEqual(await tenantBlobUsage("tenant_b"), { bytes: 7, files: 1, truncated: false });
    assert.deepEqual(calls, ["public:uploads/tenant_b/"]);
  } finally {
    process.env.BLOB_PRIVATE_READ_WRITE_TOKEN = "private";
  }
});

test("the founding workspace also owns the pre-namespace files, never backups", async () => {
  assert.deepEqual(await tenantBlobUsage("tenant_denago_cpt"), { bytes: 160, files: 3, truncated: false });
});
