/**
 * THE ASSERTION ENGINE.
 *
 * One place that knows how to interrogate a model, so that adding a model to the
 * suite is a table entry (see matrix.ts) rather than a new file. For every model
 * the matrix describes, and for every probe that model supplies, this asks the
 * same five questions from tenant A's session about tenant B's row:
 *
 *   OWN     a row CREATED through the action layer carries the acting tenant
 *   READ    reading B's row by id yields nothing
 *   UPDATE  updating B's row by id changes nothing
 *   DELETE  deleting B's row by id removes nothing
 *   LIST    a list query never contains a B row
 *
 * OWN is the one the existing test suite has no equivalent of, and it is the one
 * that catches the models in PREFLIP-TENANT-AUDIT.md — Dashboard, JourneyRun,
 * JourneyStepLog, TestDriveBooking, TimelinePin — every one of which declares a
 * tenantId, satisfies tenantSchemaContract, and is 100% unowned in production
 * because no write ever populates the column.
 *
 * WHAT COUNTS AS A PASS. The engine judges DATA, never messages. An action that
 * refuses, redirects, throws, or returns `{error}` is fine — so is one that
 * cheerfully reports success — provided B's row is unchanged afterwards. Judging
 * the return value instead would make the suite fail whenever a refusal's wording
 * changed and pass whenever a leak happened to be silent, which is backwards.
 * Every verification below is a direct read through `basePrisma` (bypass), so it
 * sees the true state of the row regardless of what the action claimed.
 *
 * ── HOW TO KNOW A PROBE IS WORTH ANYTHING ────────────────────────────────────
 *
 * By WATCHING IT FAIL. Nothing else. This suite has already produced one green
 * check that proved nothing (a PipelineStage LIST scoped by the ACTOR's own
 * pipelineId, which could not have returned B's rows however broken the tenant
 * boundary was) and two more that passed because the action they drove refused
 * on a BUSINESS rule before it reached any tenant decision at all — a
 * `retryJourneyRun` aimed at a run that was not retryable, and a `deleteById`
 * driving `cancelJourneyRun`, which changes a status and deletes nothing, so the
 * "is the row still there" check could not fail on it under any circumstances.
 * All three were caught by mutation testing and by nothing else.
 *
 * So: BREAK THE ISOLATION IN src/, RUN THE SUITE, WATCH THE SPECIFIC CHECK GO
 * RED, PUT src/ BACK. Commit first — an uncommitted mutation cannot be reverted
 * with `git checkout --` if the file is untracked, and a mutation you think you
 * reverted but did not invalidates the whole run.
 *
 * The four mutations that currently cover this table, and what each one proves
 * (all run against the ENFORCED pass, since that is the gate):
 *
 *   M1  db.ts scopeArgs   case "where"      → args     unscoped reads
 *         reds: JourneyRun LIST · JourneyStepLog READ/LIST · Dashboard OWN(defect)
 *   M2  db.ts scopeArgs   create/mutation/upsert → args   unstamped writes
 *         reds: JourneyStepLog OWN · Dashboard/Lead/ConsentRecord OWN
 *   M3  db.ts scopeArgs   where + mutation  → args     unscoped read AND write
 *         reds: JourneyRun UPDATE + LIST + cancel(defect) ·
 *               JourneyStepLog READ/DELETE/LIST
 *   M4  journeyTenant.ts  journeyTenantId() → DEFAULT_TENANT_ID
 *       tenantPredicate.ts activeTenantPredicate() → {}
 *       db.ts scopeArgs   case "create"     → args
 *         reds: JourneyRun OWN · JobCard READ · Contact/Quote/JobCard DELETE
 *
 * M4 needs THREE simultaneous edits for a reason worth keeping: JourneyRun OWN
 * is defended twice over — the journey engine writes `journeyTenantId()` into
 * the row itself AND the guard stamps the same value over it — so breaking
 * either alone leaves the probe correctly green. That is defence in depth doing
 * its job, and a probe that went red on one edit would have been measuring less,
 * not more.
 */
import type { TenantFixture } from "./seed";

export type Verdict = "pass" | "fail" | "skip";

export type CheckResult = {
  model: string;
  check: "OWN" | "READ" | "UPDATE" | "DELETE" | "LIST" | "FORGERY" | "NESTED" | "UNIQUE";
  name: string;
  verdict: Verdict;
  detail: string;
};

/** What a probe is handed: who to act as, and which row to aim at. */
export type Actor = {
  tenant: TenantFixture;
  /** Run `fn` inside this actor's session — i.e. with their cookie visible. */
  as: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Act as the tenant's global-owner user instead (for requireOwner actions). */
  asOwner: <T>(fn: () => Promise<T>) => Promise<T>;
};

export type ModelProbe = {
  /** Prisma model name; also the report label. */
  model: string;
  /** Physical table, used for direct verification through the bypass client. */
  table: string;
  /** Which action module(s) this drives — printed in the coverage report. */
  actions: string;
  /** Column the UPDATE probe tries to change. Read before/after to detect a write. */
  witness: string;

  /**
   * Create a row through the REAL action layer as `actor`, returning its id (or
   * null if the action does not expose one). The engine then reads the row's
   * tenantId directly and asserts it equals the acting tenant.
   */
  createViaAction?: (actor: Actor) => Promise<string | null>;

  /** Read `id` as `actor`. Return the row (or null). Throwing counts as "nothing". */
  readById?: (actor: Actor, id: string) => Promise<unknown>;

  /** Attempt to change `witness` on `id` as `actor`. Throwing is fine. */
  updateById?: (actor: Actor, id: string, newValue: string) => Promise<unknown>;

  /** Attempt to delete `id` as `actor`. Throwing is fine. */
  deleteById?: (actor: Actor, id: string) => Promise<unknown>;

  /** List rows visible to `actor`; return their ids. */
  list?: (actor: Actor) => Promise<string[]>;

  /**
   * Notes for the coverage report — say what ISN'T driven here. An honest gap is
   * useful; an implied one is the failure this suite exists to stop.
   */
  gaps?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = { $queryRawUnsafe: (sql: string, ...v: unknown[]) => Promise<any> };

/** Read one column of one row, bypassing every guard. Ground truth. */
async function readColumn(
  raw: Raw,
  table: string,
  id: string,
  column: string,
): Promise<string | null | undefined> {
  const rows = await raw.$queryRawUnsafe(
    `SELECT "${column}"::text AS v FROM "${table}" WHERE "id" = $1`,
    id,
  );
  if (!rows || rows.length === 0) return undefined; // row absent
  return rows[0].v;
}

async function rowExists(raw: Raw, table: string, id: string): Promise<boolean> {
  const rows = await raw.$queryRawUnsafe(`SELECT 1 AS x FROM "${table}" WHERE "id" = $1`, id);
  return rows.length > 0;
}

/** Swallow anything a probe throws — a refusal is a legitimate outcome. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ threw: boolean; value?: T; error?: unknown }> {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, error };
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { name?: string; message?: string };
    return `${e.name ?? "Error"}: ${(e.message ?? "").slice(0, 90)}`;
  }
  return String(error).slice(0, 90);
}

/**
 * Run every applicable check for one model.
 *
 * `actorA` acts; `victim` is tenant B's fixture, whose rows must be untouchable.
 */
export async function runModelChecks(
  probe: ModelProbe,
  actorA: Actor,
  victim: TenantFixture,
  victimRowId: string,
  raw: Raw,
  /**
   * The row the DELETE check aims at, when it must differ from the others.
   * SalesPipeline needs this: `archivePipeline()` refuses any pipeline that
   * still has leads, so archiving the main fixture row is refused for a business
   * reason and would read as a tenant boundary holding when it never got that
   * far. The delete probe therefore gets a leadless pipeline of its own.
   */
  victimDeleteRowId: string = victimRowId,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const push = (check: CheckResult["check"], name: string, verdict: Verdict, detail: string) =>
    out.push({ model: probe.model, check, name, verdict, detail });

  /* ── OWN: does a row created through the action layer know its tenant? ── */
  if (probe.createViaAction) {
    const made = await attempt(() => probe.createViaAction!(actorA));
    if (made.threw) {
      push("OWN", "create via action stamps the acting tenant", "skip",
        `the create action itself failed — ${describeError(made.error)}`);
    } else if (!made.value) {
      push("OWN", "create via action stamps the acting tenant", "skip",
        "the action does not expose the new row's id");
    } else {
      const owner = await readColumn(raw, probe.table, made.value, "tenantId");
      if (owner === undefined) {
        push("OWN", "create via action stamps the acting tenant", "skip",
          "the created row could not be found by the id the action returned");
      } else if (owner === actorA.tenant.tenantId) {
        push("OWN", "create via action stamps the acting tenant", "pass",
          `tenantId = ${owner}`);
      } else {
        push("OWN", "create via action stamps the acting tenant", "fail",
          owner === null
            ? `tenantId is NULL — the row is UNOWNED and becomes invisible to its own creator at the flip`
            : `tenantId = ${owner}, expected ${actorA.tenant.tenantId}`);
      }
    }
  } else {
    push("OWN", "create via action stamps the acting tenant", "skip", "no create probe supplied");
  }

  /* ── READ: B's row by id must not resolve for A ── */
  if (probe.readById) {
    const read = await attempt(() => probe.readById!(actorA, victimRowId));
    if (read.threw) {
      push("READ", "read of B's row by id returns nothing", "pass",
        `refused — ${describeError(read.error)}`);
    } else if (read.value === null || read.value === undefined) {
      push("READ", "read of B's row by id returns nothing", "pass", "returned null");
    } else if (Array.isArray(read.value) && read.value.length === 0) {
      push("READ", "read of B's row by id returns nothing", "pass", "returned []");
    } else {
      push("READ", "read of B's row by id returns nothing", "fail",
        `A received B's row: ${JSON.stringify(read.value).slice(0, 120)}`);
    }
  } else {
    push("READ", "read of B's row by id returns nothing", "skip", "no read probe supplied");
  }

  /* ── UPDATE: B's row must be unchanged afterwards ── */
  if (probe.updateById) {
    const before = await readColumn(raw, probe.table, victimRowId, probe.witness);
    const marker = `HIJACKED-BY-${actorA.tenant.key}-${Date.now().toString(36)}`;
    const result = await attempt(() => probe.updateById!(actorA, victimRowId, marker));
    const after = await readColumn(raw, probe.table, victimRowId, probe.witness);
    if (after === undefined) {
      push("UPDATE", "update of B's row changes zero rows", "fail",
        "B's row VANISHED during A's update attempt");
    } else if (before === after) {
      push("UPDATE", "update of B's row changes zero rows", "pass",
        result.threw ? `refused — ${describeError(result.error)}` : `"${probe.witness}" unchanged`);
    } else {
      push("UPDATE", "update of B's row changes zero rows", "fail",
        `A rewrote B's "${probe.witness}": ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }
  } else {
    push("UPDATE", "update of B's row changes zero rows", "skip", "no update probe supplied");
  }

  /* ── DELETE: B's row must still be there ── */
  if (probe.deleteById) {
    const target = victimDeleteRowId;
    const existedBefore = await rowExists(raw, probe.table, target);
    const result = await attempt(() => probe.deleteById!(actorA, target));
    const existsAfter = await rowExists(raw, probe.table, target);
    // Soft delete counts as a delete: the row is gone from every ordinary read.
    const softDeleted = existsAfter
      ? (await readColumn(raw, probe.table, target, "deletedAt").catch(() => null)) != null
      : false;
    if (!existedBefore) {
      push("DELETE", "delete of B's row changes zero rows", "skip",
        "B's row was already gone before the attempt");
    } else if (existsAfter && !softDeleted) {
      push("DELETE", "delete of B's row changes zero rows", "pass",
        result.threw ? `refused — ${describeError(result.error)}` : "row still present");
    } else {
      push("DELETE", "delete of B's row changes zero rows", "fail",
        softDeleted ? "A soft-deleted B's row" : "A destroyed B's row");
    }
  } else {
    push("DELETE", "delete of B's row changes zero rows", "skip", "no delete probe supplied");
  }

  /* ── LIST: a collection read must never include a B row ── */
  if (probe.list) {
    const listed = await attempt(() => probe.list!(actorA));
    if (listed.threw) {
      push("LIST", "list never contains a B row", "pass",
        `refused — ${describeError(listed.error)}`);
    } else {
      const ids = listed.value ?? [];
      const leaked = ids.filter((id) => id === victimRowId);
      if (leaked.length === 0) {
        push("LIST", "list never contains a B row", "pass", `${ids.length} row(s), none of B's`);
      } else {
        push("LIST", "list never contains a B row", "fail",
          `B's row appeared in A's list (${ids.length} row(s) returned)`);
      }
    }
  } else {
    push("LIST", "list never contains a B row", "skip", "no list probe supplied");
  }

  void victim;
  return out;
}
