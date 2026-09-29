import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { countPublicClientFiles, movePublicFilesToPrivate, type MigrationIo } from "../src/lib/privateMigration";

/**
 * Moving the public store into the private one. The rules that matter:
 * verify before deleting; never delete on a mismatch; leave intentional public
 * images; resume safely; stop on budget.
 */

type Store = Map<string, Buffer>;
const url = (pathname: string) => `https://pub.public.blob.vercel-storage.com/${pathname}`;

function fakeIo(publicStore: Store, privateStore: Store, opts: { corruptWrite?: string; failRead?: string; pageSize?: number } = {}) {
  const deleted: string[] = [];
  const io: MigrationIo = {
    async listPublic(cursor) {
      const all = [...publicStore.keys()].sort();
      const start = cursor ? Number(cursor) : 0;
      const size = opts.pageSize ?? 100;
      const slice = all.slice(start, start + size);
      return { blobs: slice.map((p) => ({ pathname: p, url: url(p) })), cursor: start + size < all.length ? String(start + size) : null };
    },
    async readPublic(u) {
      const p = u.replace(/^https:\/\/[^/]+\//, "");
      if (p === opts.failRead) throw new Error("network");
      const bytes = publicStore.get(p);
      if (!bytes) throw new Error("gone");
      return { bytes, contentType: "application/pdf" };
    },
    async existsPrivate(p) {
      return privateStore.has(p);
    },
    async writePrivate(p, bytes) {
      privateStore.set(p, p === opts.corruptWrite ? Buffer.from("corrupted") : bytes);
    },
    async readPrivate(p) {
      const b = privateStore.get(p);
      if (!b) throw new Error("missing");
      return b;
    },
    async deletePublic(u) {
      const p = u.replace(/^https:\/\/[^/]+\//, "");
      deleted.push(p);
      publicStore.delete(p);
    },
  };
  return { io, deleted };
}

test("EACH FILE IS COPIED TO THE SAME PATH, VERIFIED, AND ONLY THEN DELETED FROM THE PUBLIC STORE", async () => {
  const pub: Store = new Map([
    ["uploads/t1/document/quote:q1/invoice.pdf", Buffer.from("invoice")],
    ["library/Price List-abc.pdf", Buffer.from("prices")],
    ["backups/database/2026-09-25.json.enc", Buffer.from("backup")],
  ]);
  const priv: Store = new Map();
  const { io } = fakeIo(pub, priv);
  const pass = await movePublicFilesToPrivate({ io, shouldStop: () => false });
  assert.equal(pass.moved, 3);
  assert.equal(pass.failed.length, 0);
  assert.equal(pass.walkedEverything, true);
  assert.equal(pub.size, 0, "nothing left public");
  assert.equal(priv.get("library/Price List-abc.pdf")?.toString(), "prices", "same path, same bytes");
});

test("A COPY THAT DOESN'T MATCH IS NEVER USED TO DELETE THE ORIGINAL", async () => {
  const pub: Store = new Map([["uploads/t1/a.pdf", Buffer.from("real")], ["uploads/t1/b.pdf", Buffer.from("fine")]]);
  const priv: Store = new Map();
  const { io, deleted } = fakeIo(pub, priv, { corruptWrite: "uploads/t1/a.pdf" });
  const pass = await movePublicFilesToPrivate({ io, shouldStop: () => false });
  assert.ok(pub.has("uploads/t1/a.pdf"), "the public original is kept");
  assert.ok(!deleted.includes("uploads/t1/a.pdf"));
  assert.equal(pass.failed.length, 1);
  assert.match(pass.failed[0].error, /does not match/);
  assert.ok(!pub.has("uploads/t1/b.pdf"), "the rest still move");
});

test("a read failure keeps the public copy and moves on", async () => {
  const pub: Store = new Map([["uploads/t1/a.pdf", Buffer.from("a")], ["uploads/t1/b.pdf", Buffer.from("b")]]);
  const { io } = fakeIo(pub, new Map(), { failRead: "uploads/t1/a.pdf" });
  const pass = await movePublicFilesToPrivate({ io, shouldStop: () => false });
  assert.deepEqual([...pub.keys()], ["uploads/t1/a.pdf"]);
  assert.equal(pass.failed[0].pathname, "uploads/t1/a.pdf");
});

test("CAMPAIGN AND BOT IMAGES STAY PUBLIC — emails and WhatsApp fetch them by link", async () => {
  const pub: Store = new Map([
    ["uploads/t1/public/banner.png", Buffer.from("banner")],
    ["uploads/t1/photo.jpg", Buffer.from("photo")],
  ]);
  const { io } = fakeIo(pub, new Map());
  const pass = await movePublicFilesToPrivate({ io, shouldStop: () => false });
  assert.deepEqual([...pub.keys()], ["uploads/t1/public/banner.png"]);
  assert.equal(pass.keptPublicAssets, 1);
  assert.equal(await countPublicClientFiles(io), 0, "nothing left that should be private");
});

test("a run cut short by its budget resumes, and a copy from an earlier run is verified, not redone", async () => {
  const pub: Store = new Map([["a", Buffer.from("1")], ["b", Buffer.from("2")], ["c", Buffer.from("3")]]);
  const priv: Store = new Map();
  let budget = 1;
  const first = fakeIo(pub, priv);
  const pass1 = await movePublicFilesToPrivate({ io: first.io, shouldStop: () => budget-- <= 0 });
  assert.equal(pass1.walkedEverything, false, "stopped for budget");
  // An earlier run copied "c" but died before deleting its public copy.
  priv.set("c", Buffer.from("3"));
  const pass2 = await movePublicFilesToPrivate({ io: fakeIo(pub, priv).io, shouldStop: () => false });
  assert.equal(pub.size, 0);
  assert.equal(pass2.verifiedEarlierCopy, 1);
  assert.equal(pass2.walkedEverything, true);
});

test("an earlier copy that doesn't match is not trusted", async () => {
  const pub: Store = new Map([["x", Buffer.from("original")]]);
  const priv: Store = new Map([["x", Buffer.from("something else")]]);
  const pass = await movePublicFilesToPrivate({ io: fakeIo(pub, priv).io, shouldStop: () => false });
  assert.ok(pub.has("x"), "the public original is kept");
  assert.equal(pass.failed.length, 1);
});

test("walks every page of the public store", async () => {
  const pub: Store = new Map(Array.from({ length: 7 }, (_, i) => [`f${i}`, Buffer.from(String(i))] as [string, Buffer]));
  const { io } = fakeIo(pub, new Map(), { pageSize: 3 });
  // Deleting while walking shrinks the listing, so one pass may not reach every
  // object — the next run does. Two passes empty it.
  await movePublicFilesToPrivate({ io, shouldStop: () => false });
  await movePublicFilesToPrivate({ io, shouldStop: () => false });
  assert.equal(pub.size, 0);
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("the job runs only once new uploads are private, hourly, and touches no database", () => {
  const route = src("src/app/api/cron/private-storage/route.ts");
  assert.match(route, /if \(!isAuthorizedCron\(req\)\)/);
  assert.match(route, /if \(process\.env\.BLOB_PRIVATE !== "true" \|\| !publicToken \|\| !privateToken\)/);
  assert.ok(!/prisma|warmUpForCron/.test(route), "no database: an idle tick must not wake it");
  const crons = (JSON.parse(src("vercel.json")) as { crons: Array<{ path: string; schedule: string }> }).crons;
  assert.deepEqual(crons.find((c) => c.path === "/api/cron/private-storage")?.schedule, "20 * * * *");
  const lib = src("src/lib/privateMigration.ts");
  assert.match(lib, /addRandomSuffix: false, allowOverwrite: false, token: privateToken/, "same path, never overwriting");
});
