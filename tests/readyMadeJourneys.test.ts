import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * The ready-made journeys that replaced the built-in senders (2026-10-06): the
 * REAL ensureReadyMadeJourneys against an in-memory database. Created once per
 * workspace, OFF unless the old switch was explicitly on, never duplicated —
 * even by two page loads at once — and never re-created once the owner deletes
 * one. No real database client is ever built here.
 */

type Setting = { tenantId: string; key: string; value: string };
type Journey = { id: string; tenantId: string; name: string; status: string; runMode: string; activeVersion: number; category: string };
type Version = { tenantId: string; journeyId: string; version: number; state: string; triggers: unknown; definition: unknown; trigger: string };

const db = {
  settings: [] as Setting[],
  journeys: [] as Journey[],
  versions: [] as Version[],
  templates: [] as { id: string; tenantId: string }[],
  audits: [] as string[],
};
let lock: Promise<void> = Promise.resolve();

const sameKey = (where: { tenantId_key: { tenantId: string; key: string } }) => (s: Setting) =>
  s.tenantId === where.tenantId_key.tenantId && s.key === where.tenantId_key.key;

const client = {
  appSetting: {
    count: async ({ where }: { where: { tenantId: string; key: { in: string[] } } }) =>
      db.settings.filter((s) => s.tenantId === where.tenantId && where.key.in.includes(s.key)).length,
    findUnique: async ({ where }: { where: { tenantId_key: { tenantId: string; key: string } } }) =>
      db.settings.find(sameKey(where)) ?? null,
    findMany: async ({ where }: { where: { tenantId: string; key: { in: string[] } } }) =>
      db.settings.filter((s) => s.tenantId === where.tenantId && where.key.in.includes(s.key)),
    create: async ({ data }: { data: Setting }) => {
      // The unique (tenantId, key) index: a second marker is a constraint error.
      if (db.settings.some((s) => s.tenantId === data.tenantId && s.key === data.key)) throw new Error("P2002 unique");
      db.settings.push({ ...data });
      return data;
    },
  },
  journey: {
    create: async ({ data }: { data: Omit<Journey, "id"> }) => {
      const row = { ...data, id: `j${db.journeys.length + 1}` };
      db.journeys.push(row);
      return row;
    },
    findMany: async ({ where }: { where: { tenantId: string; id: { in: string[] } } }) =>
      db.journeys.filter((j) => j.tenantId === where.tenantId && where.id.in.includes(j.id)),
  },
  journeyVersion: { create: async ({ data }: { data: Version }) => { db.versions.push(data); return data; } },
  emailTemplate: {
    findFirst: async ({ where }: { where: { id: string; tenantId: string } }) =>
      db.templates.find((t) => t.id === where.id && t.tenantId === where.tenantId) ?? null,
  },
  // The advisory lock is the ONLY thing serialising two seeders: a transaction
  // that never takes it runs concurrently with the other, as Postgres would.
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
    let release: () => void = () => {};
    const tx = {
      ...client,
      $executeRaw: async (strings: TemplateStringsArray) => {
        if (!strings.join("?").includes("pg_advisory_xact_lock")) return 0;
        const previous = lock;
        lock = new Promise<void>((resolve) => (release = resolve));
        await previous;
        return 1;
      },
    };
    try {
      return await fn(tx);
    } finally {
      release();
    }
  },
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/readyMadeJourneys.ts")) {
    if (request === "./db") return { basePrisma: client, prisma: client };
    if (request === "./audit") return { logAudit: async (e: { summary: string }) => { db.audits.push(e.summary); } };
    if (request === "./errorLog") return { logError: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const { ensureReadyMadeJourneys, readyMadeJourneyStates } = createRequire(import.meta.url)(
  "../src/lib/readyMadeJourneys.ts",
) as typeof import("../src/lib/readyMadeJourneys");

const statusOf = (tenantId: string, name: string) => db.journeys.find((j) => j.tenantId === tenantId && j.name === name)?.status;

beforeEach(() => {
  db.settings = [];
  db.journeys = [];
  db.versions = [];
  db.templates = [];
  db.audits = [];
});

test("a workspace with no old switches gets every ready-made journey, published and OFF", async () => {
  await ensureReadyMadeJourneys("tenant_a");
  assert.deepEqual(db.journeys.map((j) => j.name), [
    "Google review request",
    "Service-due reminder",
    "Signing reminder",
    "Survey reminder (automatic surveys)",
  ]);
  for (const j of db.journeys) {
    assert.equal(j.status, "paused", `${j.name} starts off`);
    assert.equal(j.tenantId, "tenant_a");
    assert.equal(j.activeVersion, 1);
    assert.equal(j.runMode, "parallel");
    assert.equal(j.category, "automation");
  }
  assert.ok(db.versions.every((v) => v.state === "published" && v.tenantId === "tenant_a"));
  assert.deepEqual((db.versions[2].definition as { steps: { type: string }[] }).steps.map((s) => s.type), ["send_signing_reminder"]);
  assert.equal(db.audits.length, 4, "each creation is audited");
  assert.ok(db.audits.every((a) => /OFF until switched on in Journeys/.test(a)));
});

test("seeding twice — or twice at once — never makes a second copy", async () => {
  await Promise.all([ensureReadyMadeJourneys("tenant_a"), ensureReadyMadeJourneys("tenant_a")]);
  await ensureReadyMadeJourneys("tenant_a");
  assert.equal(db.journeys.length, 4);
  assert.equal(db.settings.filter((s) => s.key.startsWith("READY_MADE_JOURNEY:")).length, 4);
});

test("an old switch explicitly ON carries over; unset, false or anything else is OFF", async () => {
  db.settings.push(
    { tenantId: "tenant_a", key: "REVIEW_REQUESTS_AUTO", value: "true" },
    { tenantId: "tenant_a", key: "SIGNING_AUTO_REMINDERS", value: "false" },
    { tenantId: "tenant_a", key: "SURVEY_AUTO_REMINDERS", value: "yes" },
    // Another workspace's approval is not this one's.
    { tenantId: "tenant_b", key: "SIGNING_AUTO_REMINDERS", value: "true" },
  );
  await ensureReadyMadeJourneys("tenant_a");
  assert.equal(statusOf("tenant_a", "Google review request"), "active");
  assert.equal(statusOf("tenant_a", "Signing reminder"), "paused");
  assert.equal(statusOf("tenant_a", "Survey reminder (automatic surveys)"), "paused");
  assert.equal(statusOf("tenant_a", "Service-due reminder"), "paused");
  assert.match(db.audits[0], /ON — the built-in it replaces was switched on/);
});

test("service reminders carry over only where they were actually sending — switched on WITH a template", async () => {
  db.settings.push({ tenantId: "tenant_a", key: "SERVICE_REMINDER_ENABLED", value: "true" });
  await ensureReadyMadeJourneys("tenant_a");
  assert.equal(statusOf("tenant_a", "Service-due reminder"), "paused", "on, but no template: the old job sent nothing");

  db.settings.push(
    { tenantId: "tenant_b", key: "SERVICE_REMINDER_ENABLED", value: "true" },
    { tenantId: "tenant_b", key: "SERVICE_REMINDER_TEMPLATE_ID", value: "tpl_a" },
  );
  db.templates.push({ id: "tpl_a", tenantId: "tenant_a" });
  await ensureReadyMadeJourneys("tenant_b");
  assert.equal(statusOf("tenant_b", "Service-due reminder"), "paused", "a template id from another workspace is no template");

  db.settings.push(
    { tenantId: "tenant_c", key: "SERVICE_REMINDER_ENABLED", value: "true" },
    { tenantId: "tenant_c", key: "SERVICE_REMINDER_TEMPLATE_ID", value: "tpl_c" },
  );
  db.templates.push({ id: "tpl_c", tenantId: "tenant_c" });
  await ensureReadyMadeJourneys("tenant_c");
  assert.equal(statusOf("tenant_c", "Service-due reminder"), "active");
});

test("a ready-made journey the owner deleted is not brought back", async () => {
  await ensureReadyMadeJourneys("tenant_a");
  db.journeys = db.journeys.filter((j) => j.name !== "Signing reminder");
  await ensureReadyMadeJourneys("tenant_a");
  assert.equal(db.journeys.length, 3);
  const states = await readyMadeJourneyStates("tenant_a");
  const signing = states.find((s) => s.def.key === "signing-reminders")!;
  assert.equal(signing.status, null, "shown as deleted, not silently re-created");
  assert.equal(states.find((s) => s.def.key === "review-requests")!.status, "paused");
});
