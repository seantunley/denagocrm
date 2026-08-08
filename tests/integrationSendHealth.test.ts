import assert from "node:assert/strict";
import test from "node:test";
import Module, { createRequire } from "node:module";

import { runAfterResponse } from "../src/lib/afterResponse";
import { classifyGraphError, classifySmtpError } from "../src/lib/integrationProbe";
import { currentTenantScope } from "../src/lib/tenantScope";

/**
 * Runtime send-health recording, RUN rather than read.
 *
 * tests/integrationConfigFlow.test.ts already covers the shape of these
 * functions and the outcomes they pass around. What it cannot cover — because
 * `integrationConnection.ts` talks to a live Prisma client — are the two
 * properties the whole feature rests on, both of which fail SILENTLY in
 * production if they regress:
 *
 *   1. THE QUERY ITSELF NAMES THE TENANT. `src/lib/db.ts`'s guard extension adds
 *      a tenant predicate only when `tenantEnforcing()` is true, and it is false
 *      in production today. A write that leans on it is therefore not scoped at
 *      all: one tenant's send failure can land on, or be read from, another
 *      tenant's row. Asserting that the hook was *handed* the right tenant
 *      proves nothing about the statement that reaches Postgres, so these tests
 *      capture the actual Prisma arguments and look for the predicate in them.
 *
 *   2. THE WRITE OUTLIVES THE RESPONSE. On serverless the invocation can be
 *      frozen the instant the response flushes; anything not awaited and not
 *      registered with `waitUntil` is simply lost, with no error and no row.
 *      The lifecycle test below models exactly that — it settles only what was
 *      registered — so a return to fire-and-forget fails it.
 *
 * `./db` is swapped for an in-memory stand-in through the module loader, anchored
 * on the REQUESTING file, exactly as tests/journeyRetention.test.ts does it. That
 * buys behavioural coverage of the shipped functions without CI ever opening a
 * database connection.
 */

// ── An in-memory stand-in for the one Prisma delegate this module uses ───────

type ConnectionWhere = {
  tenantId_integrationId?: { tenantId?: string; integrationId?: string };
  tenantId?: string;
  integrationId?: string;
};
type Row = {
  integrationId: string;
  status: string;
  lastVerifiedAt: Date | null;
  blameStep: string | null;
  lastErrorCode: string | null;
  lastErrorText: string | null;
  lastErrorAt: Date | null;
};
type Call =
  | { op: "findUnique"; where: ConnectionWhere }
  | { op: "findMany"; where: ConnectionWhere }
  | { op: "upsert"; where: ConnectionWhere; create: Record<string, unknown> }
  | { op: "deleteMany"; where: ConnectionWhere };

const calls: Call[] = [];
/** The row `findUnique` should answer with, i.e. the integration's current state. */
let existing: Row | null = null;
/** The tenant the last write was pinned to — set only once the write COMPLETES. */
let committedTenant: string | null = null;

/**
 * Every operation takes a turn of the event loop, like a real round trip. Without
 * that, a write that was merely *started* would look identical to one that
 * finished, and the lifecycle test below would pass against the very bug it
 * exists to catch.
 */
const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));

const prismaStub = {
  integrationConnection: {
    async findUnique(args: { where: ConnectionWhere }): Promise<Row | null> {
      calls.push({ op: "findUnique", where: args.where });
      await roundTrip();
      return existing;
    },
    async findMany(args: { where: ConnectionWhere }): Promise<Row[]> {
      calls.push({ op: "findMany", where: args.where });
      await roundTrip();
      return existing ? [existing] : [];
    },
    async upsert(args: {
      where: ConnectionWhere;
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }): Promise<Row> {
      calls.push({ op: "upsert", where: args.where, create: args.create });
      await roundTrip();
      committedTenant = pinnedTenant(args.where) ?? null;
      return { ...(args.create as unknown as Row) };
    },
    async deleteMany(args: { where: ConnectionWhere }): Promise<{ count: number }> {
      calls.push({ op: "deleteMany", where: args.where });
      await roundTrip();
      return { count: existing ? 1 : 0 };
    },
  },
};

/**
 * The tenant a query pins ITSELF, ignoring anything the dormant guard extension
 * might have added had it been awake. `undefined` means the statement would go to
 * the database with no tenant in it.
 */
function pinnedTenant(where: ConnectionWhere): string | undefined {
  return where.tenantId_integrationId?.tenantId ?? where.tenantId;
}

function reset(current: Row | null = null): void {
  calls.length = 0;
  existing = current;
  committedTenant = null;
}

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "./db" && parent?.filename?.endsWith("integrationConnection.ts")) {
    return { prisma: prismaStub };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const store = createRequire(import.meta.url)(
  "../src/lib/integrationConnection.ts",
) as typeof import("../src/lib/integrationConnection");

// Both carry "example" so the secret scan reads them as documented placeholders
// (.gitleaks.toml allowlists that word), and "not-a-real" so a human does too.
const TOKEN = "example-access-token-not-a-real-credential";
const SMTP_PASSWORD = "example-smtp-password-not-a-real-credential";
const TENANT = "tenant_example_send_health";
const OTHER_TENANT = "tenant_example_someone_else";

const WA_PROBE = { phoneNumberId: "109876543210987", accessToken: TOKEN };
const AUTH_FAILURE = classifyGraphError(401, { error: { code: 190 } }, WA_PROBE);
const SMTP_FAILURE = classifySmtpError(
  { code: "EAUTH", responseCode: 535 },
  {
    host: "mail.example.com",
    port: 587,
    secure: false,
    user: "postmaster@example.com",
    pass: SMTP_PASSWORD,
    from: "noreply@example.com",
  },
);

const CONNECTED: Row = {
  integrationId: "whatsapp",
  status: "connected",
  lastVerifiedAt: new Date(),
  blameStep: null,
  lastErrorCode: null,
  lastErrorText: null,
  lastErrorAt: null,
};
const BROKEN: Row = {
  integrationId: "whatsapp",
  status: "reauth_required",
  lastVerifiedAt: null,
  blameStep: "credentials",
  lastErrorCode: "auth_failed",
  lastErrorText: "Meta rejected this access token.",
  lastErrorAt: new Date(),
};

// ── 1. The statement that reaches Postgres names the tenant itself ───────────

test("every send-health statement pins the tenant in its own predicate", async () => {
  // The guard extension in src/lib/db.ts is DORMANT (tenantEnforcing() is false
  // in production), so a query that does not name the tenant is not scoped by
  // anything at all — it would read and overwrite whichever row the compound key
  // happened to match. Nothing about the send path can compensate for that, which
  // is why it is asserted on the arguments rather than on the result.
  reset(BROKEN);
  await store.recordIntegrationFailure(TENANT, "whatsapp", AUTH_FAILURE, [TOKEN]);
  await store.recordIntegrationVerified(TENANT, "whatsapp");
  await store.getIntegrationConnection(TENANT, "whatsapp");
  await store.getIntegrationConnections(TENANT);
  await store.clearIntegrationVerification(TENANT, "whatsapp");

  assert.equal(calls.length, 5, "each helper should have issued exactly one statement");
  for (const call of calls) {
    assert.equal(
      pinnedTenant(call.where),
      TENANT,
      `UNSCOPED WRITE: the ${call.op} carries no tenant of its own, so with enforcement off it is pinned by nothing and can land on another tenant's row`,
    );
  }

  // The create half of an upsert is a separate statement in all but name: it runs
  // when no row matched, and a row created without a tenant belongs to nobody.
  for (const call of calls) {
    if (call.op !== "upsert") continue;
    assert.equal(
      call.create.tenantId,
      TENANT,
      "UNTENANTED ROW: the upsert's create branch omits tenantId, so a first-ever failure would insert an unowned row",
    );
  }
});

test("the tenant written is the one passed in, never one recovered from ambient scope", async () => {
  // The production case, asserted rather than assumed: with enforcement off the
  // staff chokepoint enters no scope, so there is no ambient tenant to fall back
  // on. A hook that re-derived the tenant here found null and dropped the report,
  // which is why the badge only ever moved for cron probes.
  assert.equal(currentTenantScope(), undefined, "this guard only means something with no ambient scope");

  reset(BROKEN);
  await store.noteIntegrationSendOutcome(TENANT, "whatsapp", { ok: false, failure: AUTH_FAILURE }, [TOKEN]);
  assert.equal(committedTenant, TENANT, "a real send with no request scope must still record against its own tenant");

  reset(BROKEN);
  await store.noteIntegrationSendOutcome(OTHER_TENANT, "whatsapp", { ok: false, failure: AUTH_FAILURE }, [TOKEN]);
  assert.equal(
    committedTenant,
    OTHER_TENANT,
    "MIS-ATTRIBUTED FAILURE: two tenants sending through their own credentials must not write to the same row",
  );
});

test("the failure text stored is the curated sentence, with the token scrubbed out of it", async () => {
  reset(null);
  await store.recordIntegrationFailure(
    TENANT,
    "whatsapp",
    { ...AUTH_FAILURE, message: `Meta rejected ${TOKEN}` },
    [TOKEN],
  );
  const written = calls.find((call) => call.op === "upsert");
  assert.ok(written && written.op === "upsert");
  assert.doesNotMatch(
    JSON.stringify(written.create),
    new RegExp(TOKEN),
    "LEAKED SECRET: the access token reached the database row that the settings page renders",
  );
});

// ── 2. The write outlives the response ───────────────────────────────────────

/**
 * A serverless invocation, honestly modelled: the handler runs, the response is
 * returned, and then ONLY the promises handed to `waitUntil` are given time to
 * settle. Anything else is frozen where it stands — which is precisely what
 * happens to a floating promise, and why it leaves no trace when it does.
 */
async function inOneInvocation(handler: (schedule: (work: () => Promise<void>) => Promise<void>) => Promise<void>) {
  const keptAlive: Promise<unknown>[] = [];
  const platformAfter = (task: () => Promise<void>) => {
    keptAlive.push(task());
  };
  await handler((work) => runAfterResponse(work, { after: platformAfter }));
  // ── the response is returned to the client here ──
  const registered = keptAlive.length;
  await Promise.all(keptAlive);
  return { registered };
}

test("a send-health write survives the response returning", async () => {
  reset(BROKEN);

  const { registered } = await inOneInvocation(async (schedule) => {
    await store.noteIntegrationSendOutcome(TENANT, "smtp", { ok: false, failure: SMTP_FAILURE }, [SMTP_PASSWORD], {
      schedule,
    });
    assert.equal(
      committedTenant,
      null,
      "the bookkeeping write must not have been run inline — that is latency on a customer-facing send",
    );
  });

  assert.equal(
    committedTenant,
    TENANT,
    "LOST WRITE: the response returned and nothing was holding the write, so on Vercel the invocation would have been torn down on top of it and the failure never recorded",
  );
  assert.equal(registered, 1, "the work must be registered with waitUntil, which is what extends the invocation");
});

test("nothing is dropped when the platform mechanism refuses the work", async () => {
  // `after()` throws SYNCHRONOUSLY outside a request scope (E468) and where no
  // waitUntil exists (E91) — cron sweeps run through tsx scripts, unit tests, and
  // any self-hosted runtime without the primitive. Awaiting is the other correct
  // answer there, and the one thing that must never happen is falling through the
  // failure and losing the work.
  reset(BROKEN);
  const refuse = () => {
    throw new Error("`after` was called outside a request scope");
  };
  await store.noteIntegrationSendOutcome(TENANT, "smtp", { ok: false, failure: SMTP_FAILURE }, [SMTP_PASSWORD], {
    schedule: (work) => runAfterResponse(work, { after: refuse }),
  });
  assert.equal(
    committedTenant,
    TENANT,
    "with no post-response mechanism available the write must be awaited to completion, not abandoned",
  );
});

test("a healthy send heals a stale badge but costs nothing when nothing was wrong", async () => {
  reset(BROKEN);
  await store.noteIntegrationSendOutcome(TENANT, "whatsapp", { ok: true });
  assert.equal(committedTenant, TENANT, "a send that worked must clear a Reconnect the tenant has since fixed");
  const healed = calls.find((call) => call.op === "upsert");
  assert.ok(healed && healed.op === "upsert");
  assert.equal(pinnedTenant(healed.where), TENANT, "…and the healing write is pinned like every other one");

  reset(CONNECTED);
  await store.noteIntegrationSendOutcome(TENANT, "whatsapp", { ok: true });
  assert.deepEqual(
    calls.map((call) => call.op),
    ["findUnique"],
    "an already-healthy integration must not take a row write on every single message",
  );
});

test("a broken connection store never surfaces as a failed send", async () => {
  // Reaching the end IS the assertion: this is telemetry hanging off a
  // customer-facing message, and the table may not even be migrated yet.
  reset(null);
  await store.noteIntegrationSendOutcome(TENANT, "smtp", { ok: true }, [], {
    read: async () => {
      throw new Error("relation \"IntegrationConnection\" does not exist");
    },
  });
  await store.noteIntegrationSendOutcome(TENANT, "smtp", { ok: false, failure: SMTP_FAILURE }, [SMTP_PASSWORD], {
    recordFailure: async () => {
      throw new Error("connection pool exhausted");
    },
  });
  assert.ok(true, "neither layer may rethrow");
});
