/**
 * THE DEFECT CLASSES WE HAVE ACTUALLY SHIPPED.
 *
 * The matrix asks the same five questions of every model. This file asks the
 * narrower, nastier questions that come from specific incidents rather than from
 * a general principle — the ones where the bug was not "a query forgot its
 * predicate" but "the id came from the request and nobody re-checked who owned
 * it".
 *
 * Each probe returns a CheckResult so it lands in the same report as everything
 * else, and each is written so that a PASS means the boundary held. None of them
 * assert on error text.
 */
import crypto from "node:crypto";
import type { CheckResult, Actor } from "./engine";
import type { TenantFixture } from "./seed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = { $queryRawUnsafe: (sql: string, ...v: unknown[]) => Promise<any>; $executeRawUnsafe: (sql: string, ...v: unknown[]) => Promise<any> };

const fd = (entries: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

const result = (
  check: CheckResult["check"],
  model: string,
  name: string,
  verdict: CheckResult["verdict"],
  detail: string,
): CheckResult => ({ model, check, name, verdict, detail });

async function swallow<T>(fn: () => Promise<T>): Promise<{ threw: boolean; error?: unknown }> {
  try {
    await fn();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

// Whitespace is collapsed BEFORE the slice, not after. A Prisma engine error's
// message opens with two blank lines and an "Invalid `prisma.x()` invocation:"
// banner, so the first 80 raw characters are mostly newlines — the report loses
// its column alignment and the 80 characters that survive say nothing. Squashed,
// the same budget reaches the constraint name, which is the whole point of
// printing it.
const brief = (e: unknown) => {
  const x = e as { name?: string; message?: string };
  const message = (x?.message ?? String(e)).replace(/\s+/g, " ").trim();
  return `${x?.name ?? "Error"}: ${message.slice(0, 140)}`;
};

export async function runDefectProbes(
  actorA: Actor,
  victim: TenantFixture,
  raw: Raw,
  enforcing: boolean,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const pipelines = await import("../../src/app/actions/pipelines");
  const quotes = await import("../../src/app/actions/quotes");
  const leads = await import("../../src/app/actions/leads");
  const jobcards = await import("../../src/app/actions/jobcards");

  /* ── 1. A FORGED PARENT ID IN A FORM POST ───────────────────────────────
   * `createSalesPipelineStage(pipelineId, formData)` takes the pipeline id
   * straight from the request. lib/pipelines.ts#addPipelineStage then checks
   * the pipeline EXISTS — with no tenant predicate — and inserts a stage into
   * it. So the question is whether tenant A can add a stage to tenant B's
   * pipeline by posting B's id, which is a thing any browser devtools can do.
   */
  {
    const beforeIds = await ownedStageIds(raw, victim.rows.pipelineId);
    const attempt = await swallow(() =>
      actorA.as(() =>
        pipelines.createSalesPipelineStage(
          victim.rows.pipelineId,
          fd({ name: `forged-${Date.now().toString(36)}`, defaultProbability: "15" }),
        ),
      ),
    );
    const afterIds = await ownedStageIds(raw, victim.rows.pipelineId);
    const added = afterIds.filter((id) => !beforeIds.includes(id));
    if (added.length === 0) {
      out.push(result("FORGERY", "SalesPipeline", "forged pipelineId cannot add a stage to another tenant's pipeline",
        "pass", attempt.threw ? `refused — ${brief(attempt.error)}` : "no stage was added"));
    } else {
      const owner = await columnOf(raw, "PipelineStage", added[0], "tenantId");
      out.push(result("FORGERY", "SalesPipeline", "forged pipelineId cannot add a stage to another tenant's pipeline",
        "fail",
        `A inserted a stage into B's pipeline (new stage tenantId=${owner ?? "NULL"}) — ` +
        `B's pipeline now contains a row A owns`));
    }
  }

  /* ── 2. A FORGED RECORD ID IN A SAVE PAYLOAD ────────────────────────────
   * saveQuoteDraft carries the quote id INSIDE the payload rather than in the
   * URL, so a forged id here is a single edited field in a POST body. Asserted
   * on the victim's stored terms, not on the return value.
   */
  {
    const before = await columnOf(raw, "Quote", victim.rows.quoteId, "terms");
    const marker = `FORGED-${Date.now().toString(36)}`;
    const attempt = await swallow(() =>
      actorA.as(() =>
        quotes.saveQuoteDraft({
          id: victim.rows.quoteId,
          contactId: actorA.tenant.rows.contactId,
          terms: marker,
          intent: "draft",
          items: [],
        } as Parameters<typeof quotes.saveQuoteDraft>[0]),
      ),
    );
    const after = await columnOf(raw, "Quote", victim.rows.quoteId, "terms");
    out.push(
      before === after
        ? result("FORGERY", "Quote", "forged quoteId in a save payload cannot rewrite another tenant's quote",
            "pass", attempt.threw ? `refused — ${brief(attempt.error)}` : "terms unchanged")
        : result("FORGERY", "Quote", "forged quoteId in a save payload cannot rewrite another tenant's quote",
            "fail", `A rewrote B's quote terms: ${JSON.stringify(before)} → ${JSON.stringify(after)}`),
    );
  }

  /* ── 3. A FORGED FOREIGN KEY THAT MOVES A ROW ACROSS THE BOUNDARY ───────
   * updateLead takes stageId from the form. Pointing A's own lead at B's stage
   * does not touch a B row at all — it drags an A row into B's pipeline, which
   * is the same boundary crossed from the other side and is invisible to any
   * check that only looks for writes to B's rows.
   */
  {
    const attempt = await swallow(() =>
      actorA.as(() =>
        leads.updateLead(
          actorA.tenant.rows.leadId,
          fd({ name: "forged stage move", title: "forged stage move", stageId: victim.rows.stageId }),
        ),
      ),
    );
    const landed = await columnOf(raw, "Lead", actorA.tenant.rows.leadId, "stageId");
    out.push(
      landed === victim.rows.stageId
        ? result("FORGERY", "Lead", "forged stageId cannot move A's lead into B's pipeline stage",
            "fail", "A's lead now sits in a stage owned by B — a cross-tenant foreign key")
        : result("FORGERY", "Lead", "forged stageId cannot move A's lead into B's pipeline stage",
            "pass", attempt.threw ? `refused — ${brief(attempt.error)}` : "stageId unchanged"),
    );
    // Put it back so later checks see the fixture they expect.
    await raw.$executeRawUnsafe(`UPDATE "Lead" SET "stageId" = $1 WHERE "id" = $2`,
      actorA.tenant.rows.stageId, actorA.tenant.rows.leadId);
  }

  /* ── 4. A NESTED CREATE THAT INHERITS NO TENANT ─────────────────────────
   * Prisma query extensions intercept only TOP-LEVEL operations, so a relation
   * write nested inside another model's `data` is neither stamped nor checked
   * by the guard. db.ts documents this and says such writes are REFUSED under
   * enforcement. This drives that path through the scoped client the app uses.
   */
  {
    const { prisma } = await import("../../src/lib/db");
    const attempt = await swallow(() =>
      actorA.as(() =>
        prisma.journey.create({
          data: {
            name: `nested-${Date.now().toString(36)}`,
            status: "draft",
            trigger: "manual",
            // The nested relation write the guard is documented to refuse.
            versions: { create: { version: 99, steps: [] } },
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ),
    );
    if (enforcing) {
      out.push(
        attempt.threw
          ? result("NESTED", "Journey", "a nested relation write is refused under enforcement",
              "pass", `refused — ${brief(attempt.error)}`)
          : result("NESTED", "Journey", "a nested relation write is refused under enforcement",
              "fail", "the nested create was accepted; the child row was never tenant-stamped"),
      );
    } else {
      // Dormant: the write is expected to succeed. What matters is whether the
      // CHILD it created carries a tenant — it cannot, and that is the point.
      const orphans = await raw.$queryRawUnsafe(
        `SELECT count(*) AS n FROM "JourneyVersion" WHERE "version" = 99 AND "tenantId" IS NULL`,
      );
      const n = Number(orphans[0]?.n ?? 0);
      out.push(
        n === 0
          ? result("NESTED", "Journey", "a nested create leaves no unowned child row",
              "pass", attempt.threw ? `the create was refused — ${brief(attempt.error)}` : "child carried a tenant")
          : result("NESTED", "Journey", "a nested create leaves no unowned child row",
              "fail", `${n} JourneyVersion row(s) created with tenantId NULL by a nested write`),
      );
    }
    await raw.$executeRawUnsafe(`DELETE FROM "JourneyVersion" WHERE "version" = 99`).catch(() => 0);
    await raw.$executeRawUnsafe(`DELETE FROM "Journey" WHERE "name" LIKE 'nested-%'`).catch(() => 0);
  }

  /* ── 5. A ROW WRITTEN WHILE DORMANT, READ AFTER THE FLIP ────────────────
   * The migration path in one probe: plant the row today's code actually
   * produces (tenantId NULL — this is what production holds for Dashboard,
   * JourneyRun, JourneyStepLog, TestDriveBooking and TimelinePin) and ask who
   * can see it. Dormant, everyone can; enforced, nobody can, including the
   * tenant that created it. Both answers are recorded because the pair IS the
   * finding: the same row is over-shared before the flip and lost after it.
   */
  {
    const orphanId = `orphan-${Date.now().toString(36)}`;
    await raw.$executeRawUnsafe(
      `INSERT INTO "Dashboard" ("id","tenantId","userId","slug","title","sortOrder","config","updatedAt")
       VALUES ($1, NULL, $2, $3, 'orphan dashboard', 99, '{}'::jsonb, now())`,
      orphanId,
      actorA.tenant.memberUserId,
      orphanId,
    );
    const { prisma } = await import("../../src/lib/db");
    const seen = await actorA.as(async () =>
      prisma.dashboard.findMany({ where: { id: orphanId }, select: { id: true } }),
    ).catch(() => [] as Array<{ id: string }>);

    if (enforcing) {
      out.push(
        seen.length === 0
          ? result("OWN", "Dashboard", "a NULL-tenant row written while dormant is INVISIBLE after the flip",
              "pass",
              "confirmed — the row its own creator can see today disappears at the flip. " +
              "Production holds 1/1 Dashboard, 6/6 JourneyRun, 6/6 JourneyStepLog, 2/2 TestDriveBooking, 7/7 TimelinePin in this state.")
          : result("OWN", "Dashboard", "a NULL-tenant row written while dormant is INVISIBLE after the flip",
              "fail", "the unowned row was still readable under enforcement — the guard let a NULL tenant through"),
      );
    } else {
      out.push(result("OWN", "Dashboard", "a NULL-tenant row is readable while dormant (baseline)",
        seen.length > 0 ? "pass" : "fail",
        seen.length > 0
          ? "visible, as expected while dormant — this row will vanish at the flip"
          : "unexpectedly invisible even while dormant"));
    }
    await raw.$executeRawUnsafe(`DELETE FROM "Dashboard" WHERE "id" = $1`, orphanId).catch(() => 0);
  }

  /* ── 5b. A STATUS CHANGE THAT DESTROYS WORK WITHOUT DELETING A ROW ──────
   * `cancelJourneyRun` stops a live sequence dead. It leaves the row in place,
   * so the matrix's DELETE check — which asks whether the row still exists —
   * could never fail on it no matter how open the boundary was; a probe there
   * would have been a guaranteed pass, which is worse than no probe. Asked here
   * instead, against the only fact that settles it: B's run status.
   *
   * The target is B's QUEUED run, because cancelJourneyRun refuses anything not
   * queued or waiting. Aimed at the running fixture row it would refuse on that
   * business rule and read as the boundary holding.
   */
  {
    const journeyRuns = await import("../../src/app/actions/journeyRuns");
    const target = victim.rows.journeyRunQueuedId;
    const before = await columnOf(raw, "JourneyRun", target, "status");
    const attempt = await swallow(() => actorA.as(() => journeyRuns.cancelJourneyRun(target)));
    const after = await columnOf(raw, "JourneyRun", target, "status");
    out.push(
      before === after
        ? result("UPDATE", "JourneyRun", "A cannot cancel another tenant's queued run",
            "pass", attempt.threw ? `refused — ${brief(attempt.error)}` : `status still ${before}`)
        : result("UPDATE", "JourneyRun", "A cannot cancel another tenant's queued run",
            "fail",
            `A stopped B's live journey run: status ${JSON.stringify(before)} → ${JSON.stringify(after)}. ` +
            `No row was deleted, so nothing that counts rows would have noticed.`),
    );
    await raw.$executeRawUnsafe(
      `UPDATE "JourneyRun" SET "status" = $1, "completedAt" = NULL, "lastError" = NULL WHERE "id" = $2`,
      before, target,
    );
  }

  /* ── 6. GLOBAL UNIQUE INDEXES THAT ONLY ONE TENANT CAN SATISFY ──────────
   * Not an isolation leak — the opposite. These are constraints with no tenant
   * column in them, so the SECOND tenant to want an ordinary thing simply
   * cannot have it. Found by this harness on its first attempt to seed two
   * tenants, and invisible to any test that only ever creates one.
   */
  {
    const probeId = `uniq-${Date.now().toString(36)}`;
    const attempt = await swallow(() =>
      raw.$executeRawUnsafe(
        `INSERT INTO "SalesPipeline" ("id","tenantId","name","type","active","isDefault","updatedAt")
         VALUES ($1,$2,$3,'sales',true,true,now())`,
        probeId,
        victim.tenantId,
        `second default ${probeId}`,
      ),
    );
    out.push(
      attempt.threw
        ? result("UNIQUE", "SalesPipeline", "two tenants can each own a DEFAULT pipeline",
            "fail",
            `SalesPipeline_single_default_key is UNIQUE on ("isDefault") WHERE isDefault = true, with no tenant ` +
            `column — only ONE default pipeline may exist database-wide, and the migrations already seed it ` +
            `(pipeline_default_retail, tenant_denago_cpt). A second workspace can never have a default pipeline. ` +
            `${brief(attempt.error)}`)
        : result("UNIQUE", "SalesPipeline", "two tenants can each own a DEFAULT pipeline", "pass", "both accepted"),
    );
    await raw.$executeRawUnsafe(`DELETE FROM "SalesPipeline" WHERE "id" = $1`, probeId).catch(() => 0);
  }

  {
    const sharedName = `Sales ${Date.now().toString(36)}`;
    const idA = `uniqA-${Date.now().toString(36)}`;
    const idB = `uniqB-${Date.now().toString(36)}`;
    await raw.$executeRawUnsafe(
      `INSERT INTO "SalesPipeline" ("id","tenantId","name","type","active","isDefault","updatedAt")
       VALUES ($1,$2,$3,'sales',true,false,now())`,
      idA, actorA.tenant.tenantId, sharedName,
    );
    const attempt = await swallow(() =>
      raw.$executeRawUnsafe(
        `INSERT INTO "SalesPipeline" ("id","tenantId","name","type","active","isDefault","updatedAt")
         VALUES ($1,$2,$3,'sales',true,false,now())`,
        idB, victim.tenantId, sharedName,
      ),
    );
    out.push(
      attempt.threw
        ? result("UNIQUE", "SalesPipeline", "two tenants can each have a pipeline with the same NAME",
            "fail",
            `SalesPipeline_name_key is UNIQUE on (name) WHERE deletedAt IS NULL, with no tenant column — ` +
            `if one tenant names a pipeline "Sales", no other tenant can. ${brief(attempt.error)}`)
        : result("UNIQUE", "SalesPipeline", "two tenants can each have a pipeline with the same NAME", "pass", "both accepted"),
    );
    await raw.$executeRawUnsafe(`DELETE FROM "SalesPipeline" WHERE "id" = ANY($1::text[])`, [idA, idB]).catch(() => 0);
  }

  /* ── 7. A REVISION AND EVERY CHILD ROW IT COPIES ────────────────────────
   * `createQuoteRevision` copies a quote into a new one: the header, its
   * QuoteItems, its QuoteFees and its quote CustomFieldValues. PRISMA INHERITS
   * NOTHING — a nested `items: { create: [...] }` is not stamped by the db.ts
   * guard (which only sees top-level operations) and not stamped by the parent
   * row either, so each child needs its own explicit `tenantId` in the payload.
   * Four separate stamps, on the bypass client, in one transaction; any one of
   * them dropped leaves rows that vanish at the flip.
   *
   * #459 proved this by asserting on SOURCE TEXT. This asserts on the four
   * PERSISTED tenantId columns, read back through the bypass client.
   */
  {
    const planted = await plantQuoteWithChildren(
      raw, actorA.tenant.tenantId, "own", actorA.tenant.rows.contactId, actorA.tenant.rows.leadId,
    );
    const attempt = await swallow(() => actorA.as(() => quotes.createQuoteRevision(planted.quoteId)));
    const revisionId = await revisionOf(raw, planted.quoteId);

    if (!revisionId) {
      out.push(result("OWN", "Quote", "a revision and every child row it copies carry the tenant",
        "skip",
        `no revision row was created, so nothing was measured — ${attempt.threw ? brief(attempt.error) : "the action returned without creating one"}`));
    } else {
      const wrong = await misownedRows(raw, actorA.tenant.tenantId, [
        ["Quote", "id", revisionId],
        ["QuoteItem", "quoteId", revisionId],
        ["QuoteFee", "quoteId", revisionId],
        ["CustomFieldValue", "recordId", revisionId],
      ]);
      out.push(
        wrong.length === 0
          ? result("OWN", "Quote", "a revision and every child row it copies carry the tenant",
              "pass", `revision + ${planted.childCount} copied child row(s) all stamped ${actorA.tenant.tenantId}`)
          : result("OWN", "Quote", "a revision and every child row it copies carry the tenant",
              "fail",
              `${wrong.join("; ")}. Prisma does not inherit tenantId into a nested create, so each of ` +
              `Quote, QuoteItem, QuoteFee and the copied CustomFieldValue needs its own stamp.`),
      );
    }
    await dropPlantedQuote(raw, planted, revisionId);
  }

  /* ── 8. A REVISION OF SOMEONE ELSE'S QUOTE ──────────────────────────────
   * The sharp end of the same code. A revision must inherit the ORIGINAL's
   * tenant — `original.tenantId ?? actingTenant` — so that an admin who reaches
   * another workspace's quote cannot RE-OWN it by revising it. Stamping the
   * acting workspace instead would move the row, its lines, its fees and its
   * custom-field values across the boundary and leave every one of them looking
   * perfectly well-formed.
   *
   * Aimed at a FRESHLY PLANTED victim quote, not `rows.quoteId`: the matrix's
   * DELETE probe soft-deletes B's fixture quote during the dormant run, and
   * `createQuoteRevision` returns null for a deleted original — so a probe aimed
   * there would be refused on a BUSINESS rule and read as the boundary holding.
   *
   * REACHABILITY IS MEASURED FIRST, and it is what gives "no revision was
   * created" a meaning. That outcome has two completely opposite causes:
   *
   *   the access gate refused    the boundary held before any stamp was chosen.
   *                              This is the enforced-mode answer, and a pass.
   *   the gate let A through,    the copy was attempted and the DATABASE threw
   *   and the write failed       it out. The composite FK
   *                              `Quote_tenantId_revisionOfId_fkey` requires a
   *                              revision to carry its original's tenant, so
   *                              this happens precisely when the code stamps
   *                              the ACTING workspace — the defect. A FAILURE.
   *
   * Without the distinction the mutation that swaps `original.tenantId ??
   * actingTenant` for `actingTenant` shows up as a SKIP rather than a failure,
   * which the gate does not act on. Confirmed by running exactly that mutation.
   */
  {
    const planted = await plantQuoteWithChildren(
      raw, victim.tenantId, "victim", victim.rows.contactId, victim.rows.leadId,
    );
    // A pure read through the same access gate `createQuoteRevision` opens with.
    const reachable = await actorA
      .as(() => quotes.quoteEditorRecord(planted.quoteId))
      .then((r) => r != null)
      .catch(() => false);
    const attempt = await swallow(() => actorA.as(() => quotes.createQuoteRevision(planted.quoteId)));
    const revisionId = await revisionOf(raw, planted.quoteId);
    const superseded = await columnOf(raw, "Quote", planted.quoteId, "supersededAt");

    /* 8a. Whatever else happened, B's original must be untouched. Superseding it
     * makes it read-only and kills its signing link — destructive, and invisible
     * to anything that only counts rows. */
    out.push(
      superseded == null
        ? result("FORGERY", "Quote", "a revision attempt cannot supersede another tenant's original",
            "pass", attempt.threw ? `refused — ${brief(attempt.error)}` : "supersededAt still NULL")
        : result("FORGERY", "Quote", "a revision attempt cannot supersede another tenant's original",
            "fail", `A superseded B's quote (supersededAt = ${superseded}) — it is now read-only to its owner`),
    );

    /* 8b. And if a revision WAS created, it belongs to B. */
    const inheritName = "a revision of another tenant's quote is not re-owned by the acting workspace";
    if (!revisionId && !reachable) {
      out.push(result("FORGERY", "Quote", inheritName, "pass",
        `A cannot reach B's quote in this mode, so the access gate refused before any tenant was chosen — ` +
        `${attempt.threw ? brief(attempt.error) : "the action declined"}`));
    } else if (!revisionId) {
      out.push(result("FORGERY", "Quote", inheritName, "fail",
        `A COULD reach B's quote, drove createQuoteRevision, and NO revision row exists. On correct code ` +
        `that call produces a revision carrying B's tenant. A copy that cannot be written at all means the ` +
        `tenant the code chose was rejected by the database — Quote_tenantId_revisionOfId_fkey requires a ` +
        `revision to carry its ORIGINAL's tenant, so it is rejected exactly when the ACTING workspace is ` +
        `stamped instead. ${attempt.threw ? brief(attempt.error) : "the action returned without creating one"}`));
    } else {
      const stolen = await misownedRows(raw, victim.tenantId, [
        ["Quote", "id", revisionId],
        ["QuoteItem", "quoteId", revisionId],
        ["QuoteFee", "quoteId", revisionId],
        ["CustomFieldValue", "recordId", revisionId],
      ]);
      out.push(
        stolen.length === 0
          ? result("FORGERY", "Quote", "a revision of another tenant's quote is not re-owned by the acting workspace",
              "pass", `the revision and its ${planted.childCount} copied child row(s) stayed with ${victim.tenantId}`)
          : result("FORGERY", "Quote", "a revision of another tenant's quote is not re-owned by the acting workspace",
              "fail",
              `A revised B's quote and the copy came out owned by the ACTING workspace: ${stolen.join("; ")}. ` +
              `Revising is not a transfer of ownership.`),
      );
    }
    await dropPlantedQuote(raw, planted, revisionId);
  }

  /* ── 9. A FORGED partId THAT DECREMENTS ANOTHER WORKSPACE'S STOCK ───────
   * `addJobCardItem` authorises the JOB CARD and then takes `partId` straight
   * from the same form post. `claimPartStock` runs on the BYPASS client, so
   * authorising the job card said nothing whatever about the part: a forged id
   * locked, counted and DECREMENTED another workspace's stock, and the only
   * trace was a number going down in a workshop nobody there had touched.
   *
   * The fix put the tenant predicate on the lock, the read, the reservation
   * aggregate, the updateMany and a count check. Asserted here on B's stockQty
   * and on B's reservations — never on the returned error, which is the same
   * "Only 0 × part in stock" whether the boundary held or the part did not exist.
   *
   * ⚠ THIS PROBE WATCHES THE HOLE, NOT ANY ONE LAYER, and the difference matters
   * because THREE things now defend it and each one hides the next. Measured by
   * mutation, against this database, one edit at a time:
   *
   *   tenant predicate off the ROW LOCK alone          check stays GREEN
   *   tenant predicate off the updateMany alone        check stays GREEN
   *     Both are shadowed by the `findFirst`: it still filters, returns null, and
   *     claimPartStock bails at `if (!part)` before reaching either.
   *   predicate off the findFirst AND the updateMany   check stays GREEN
   *     The decrement now runs — but the JobCardItem written in the SAME
   *     transaction must satisfy the composite FK
   *     `JobCardItem(tenantId, partId) → Part(tenantId, id)`, which a forged
   *     partId cannot, so the whole transaction rolls back and takes the
   *     decrement with it.
   *   the same, plus that FK dropped                   check goes RED, 25 → 22
   *
   * So a green tick here does NOT certify any individual predicate in
   * claimPartStock. It certifies that B's stock cannot be spent — which is the
   * fact worth having, and the only one an outcome-based probe can honestly
   * claim. The load-bearing layer today is the composite FK, and it is the
   * FRAGILE one: it lives in raw migration SQL, not in schema.prisma, so a
   * schema-driven migration can drop it without the word "tenant" appearing in
   * a diff. If it ever goes, this check is what still notices.
   *
   * A CONTROL RUNS FIRST. Without it this probe is worthless: if
   * `requireJobCardAccess` refused, or the automotive module were off, or the
   * quantity parse rejected, B's stock would be unchanged for a reason that has
   * nothing to do with tenancy and the check would report a pass. The control
   * claims A's OWN part through the identical call, so the probe only renders a
   * verdict once the path is proven to reach the decrement.
   */
  {
    const controlBefore = Number(await columnOf(raw, "Part", actorA.tenant.rows.partId, "stockQty"));
    await swallow(() =>
      actorA.as(() =>
        jobcards.addJobCardItem(actorA.tenant.rows.jobCardId, fd({
          kind: "part", partId: actorA.tenant.rows.partId, qty: "2",
          description: `control claim ${Date.now().toString(36)}`, unitPrice: "100",
        })),
      ),
    );
    const controlAfter = Number(await columnOf(raw, "Part", actorA.tenant.rows.partId, "stockQty"));
    const pathWorks = controlAfter === controlBefore - 2;

    const before = Number(await columnOf(raw, "Part", victim.rows.partId, "stockQty"));
    const reservedBefore = await countRows(raw,
      `SELECT count(*) AS n FROM "PartReservation" WHERE "partId" = $1`, victim.rows.partId);
    const attempt = await swallow(() =>
      actorA.as(() =>
        jobcards.addJobCardItem(actorA.tenant.rows.jobCardId, fd({
          kind: "part", partId: victim.rows.partId, qty: "3",
          description: `forged claim ${Date.now().toString(36)}`, unitPrice: "100",
        })),
      ),
    );
    const after = Number(await columnOf(raw, "Part", victim.rows.partId, "stockQty"));
    const reservedAfter = await countRows(raw,
      `SELECT count(*) AS n FROM "PartReservation" WHERE "partId" = $1`, victim.rows.partId);
    const forgedLines = await countRows(raw,
      `SELECT count(*) AS n FROM "JobCardItem" WHERE "partId" = $1 AND "jobCardId" = $2`,
      victim.rows.partId, actorA.tenant.rows.jobCardId);

    const name = "a forged partId cannot decrement another tenant's stock";
    if (!pathWorks) {
      out.push(result("FORGERY", "Part", name, "skip",
        `the control claim on A's OWN part did not decrement it (${controlBefore} → ${controlAfter}), so this ` +
        `call never reaches claimPartStock and a "stock unchanged" result would prove nothing`));
    } else if (after === before && reservedAfter === reservedBefore) {
      out.push(result("FORGERY", "Part", name, "pass",
        `B's stockQty still ${after}, no PartReservation created` +
        (attempt.threw ? ` — ${brief(attempt.error)}` : "")));
    } else {
      out.push(result("FORGERY", "Part", name, "fail",
        `A spent B's stock through a forged partId: stockQty ${before} → ${after}, ` +
        `PartReservation rows ${reservedBefore} → ${reservedAfter}, ` +
        `${forgedLines} job-card line(s) on A's card now point at B's part`));
    }

    // Put A's control claim back and drop both lines, so later probes and the
    // teardown see the fixture they expect.
    await raw.$executeRawUnsafe(
      `DELETE FROM "JobCardItem" WHERE "jobCardId" = $1 AND "description" LIKE '%claim %'`,
      actorA.tenant.rows.jobCardId,
    ).catch(() => 0);
    await raw.$executeRawUnsafe(`UPDATE "Part" SET "stockQty" = $1 WHERE "id" = $2`,
      controlBefore, actorA.tenant.rows.partId).catch(() => 0);
  }

  /* ── 10. THE SAME DEFECT WITH THE SIGN FLIPPED ──────────────────────────
   * `deleteJobCardItem` gives the stock back: `part.updateMany({ where: { id:
   * owned.partId, tenantId } })`. Take the tenant predicate off that and a line
   * pointing at another workspace's part CREDITS their stock instead — parts
   * appearing out of nowhere, which nobody reads as a security event.
   *
   * TWO LAYERS DEFEND THIS, AND THE PROBE HAS TO KNOW WHICH ONE IT IS WATCHING.
   * Writing the line at all requires a row that satisfies the composite foreign
   * key `JobCardItem(tenantId, partId) → Part(tenantId, id)` — raw SQL from
   * migration 20260727140000_composite_tenant_fks, invisible in schema.prisma —
   * so with the constraint in place the offending row cannot exist and the
   * restore path is unreachable rather than merely guarded. That is a stronger
   * guarantee than the predicate, and it is also a fragile one: the constraint
   * is not in the Prisma schema, so a schema-driven migration can drop it
   * without anybody writing the word "tenant" in a diff.
   *
   * So the probe attempts the write FIRST and branches on what the database
   * says. Either way it goes red if the protection disappears — refused means
   * the schema is holding; accepted means the predicate is now the only thing
   * left, and it is then asked directly.
   *
   * THE DELETION IS THE CONTROL on the second branch. If the line were still
   * there afterwards the restore never ran, and "B's stock is unchanged" would
   * be a statement about `findFirst` refusing, not about the credit being scoped.
   */
  {
    const lineId = `hqline-${crypto.randomUUID()}`;
    const name = "a job-card line cannot credit another tenant's stock when it is deleted";
    const planted = await swallow(() =>
      raw.$executeRawUnsafe(
        `INSERT INTO "JobCardItem" ("id","tenantId","kind","description","qty","unitPriceCents","jobCardId","partId")
         VALUES ($1,$2,'part','forged restore probe',7,1000,$3,$4)`,
        lineId, actorA.tenant.tenantId, actorA.tenant.rows.jobCardId, victim.rows.partId,
      ),
    );

    if (planted.threw) {
      out.push(result("FORGERY", "Part", name, "pass",
        `UNREACHABLE BY CONSTRUCTION — the database refused to file the line at all. The composite FK ` +
        `JobCardItem(tenantId, partId) → Part(tenantId, id) means no row A owns can point at B's part, ` +
        `so the tenant predicate on the restore updateMany is a second layer over a schema constraint. ` +
        `${brief(planted.error)}`));
    } else {
      const before = Number(await columnOf(raw, "Part", victim.rows.partId, "stockQty"));
      const attempt = await swallow(() =>
        actorA.as(() => jobcards.deleteJobCardItem(lineId, actorA.tenant.rows.jobCardId, fd({ reason: "harness restore probe" }))),
      );
      const after = Number(await columnOf(raw, "Part", victim.rows.partId, "stockQty"));
      const lineGone = (await columnOf(raw, "JobCardItem", lineId, "id")) === undefined;

      if (!lineGone) {
        out.push(result("FORGERY", "Part", name, "skip",
          `the composite FK no longer refuses a cross-tenant part line, AND the line was not deleted, so ` +
          `the stock-restore branch never ran and B's unchanged stock proves nothing — ` +
          `${attempt.threw ? brief(attempt.error) : "the action declined"}`));
      } else if (after === before) {
        out.push(result("FORGERY", "Part", name, "pass",
          `the composite FK no longer refuses a cross-tenant part line, but the restore predicate held: ` +
          `line deleted, B's stockQty still ${after}`));
      } else {
        out.push(result("FORGERY", "Part", name, "fail",
          `A's line deletion credited B's stock: stockQty ${before} → ${after}. Restoring stock is a ` +
          `decrement in reverse and needs the same tenant predicate on the updateMany.`));
      }
      await raw.$executeRawUnsafe(`UPDATE "Part" SET "stockQty" = $1 WHERE "id" = $2`,
        before, victim.rows.partId).catch(() => 0);
    }
    await raw.$executeRawUnsafe(`DELETE FROM "JobCardItem" WHERE "id" = $1`, lineId).catch(() => 0);
  }

  /* ── 11. THE RESERVATION PATH, WHICH TAKES THE SAME FORGED id ───────────
   * `reservePart` earmarks stock without consuming it, and it takes `partId`
   * from the form exactly as `addJobCardItem` does. It runs on the SCOPED client
   * rather than the bypass one, so the boundary here is the db.ts guard and not
   * an explicit predicate — which means the two paths fail in different modes
   * and the pair is worth reporting separately.
   *
   * Judged on whether a PartReservation row against B's part exists afterwards.
   */
  {
    const before = await countRows(raw,
      `SELECT count(*) AS n FROM "PartReservation" WHERE "partId" = $1`, victim.rows.partId);
    const attempt = await swallow(() =>
      actorA.as(() =>
        jobcards.reservePart(actorA.tenant.rows.jobCardId, fd({ partId: victim.rows.partId, qty: "4" })),
      ),
    );
    const after = await countRows(raw,
      `SELECT count(*) AS n FROM "PartReservation" WHERE "partId" = $1`, victim.rows.partId);
    const name = "a forged partId cannot reserve another tenant's stock";
    out.push(
      after === before
        ? result("FORGERY", "PartReservation", name, "pass",
            attempt.threw ? `refused — ${brief(attempt.error)}` : "no reservation was created")
        : result("FORGERY", "PartReservation", name, "fail",
            `A earmarked B's stock: ${after - before} PartReservation row(s) now hold B's part against A's ` +
            `job card, so B's available quantity drops with nothing on B's side to explain it`),
    );
    await raw.$executeRawUnsafe(
      `DELETE FROM "PartReservation" WHERE "partId" = $1 AND "jobCardId" = $2`,
      victim.rows.partId, actorA.tenant.rows.jobCardId,
    ).catch(() => 0);
  }

  return out;
}

type PlantedQuote = { quoteId: string; defId: string; childCount: number };

/**
 * Plant a quote that ALREADY HAS CHILDREN, owned outright by `tenantId`.
 *
 * Raw SQL, for the same reason seed.ts uses it: the fixture must be a CORRECTLY
 * OWNED world, so that any wrong tenantId seen afterwards was put there by the
 * action under test rather than inherited from a sloppy setup.
 *
 * `number` is allocated as MAX+1 rather than hashed, because Quote.number is
 * globally @unique and a hash collision with a seeded row would fail the insert
 * as a unique violation that looks nothing like the constraint it actually is.
 */
async function plantQuoteWithChildren(
  raw: Raw,
  tenantId: string,
  label: string,
  contactId: string,
  leadId: string,
): Promise<PlantedQuote> {
  const quoteId = `hq-${label}-${crypto.randomUUID()}`;
  const defId = `hqdef-${label}-${crypto.randomUUID()}`;
  await raw.$executeRawUnsafe(
    `INSERT INTO "Quote" ("id","tenantId","number","status","contactId","leadId","terms","updatedAt")
     VALUES ($1,$2,(SELECT COALESCE(MAX("number"),0) + 1 FROM "Quote"),'draft',$3,$4,$5,now())`,
    quoteId, tenantId, contactId, leadId, `${label} revision-probe terms`,
  );
  for (const [n, description] of [[0, "probe line one"], [1, "probe line two"]] as const) {
    await raw.$executeRawUnsafe(
      `INSERT INTO "QuoteItem" ("id","tenantId","description","qty","unitPriceCents","sortOrder","quoteId")
       VALUES ($1,$2,$3,1,50000,$4,$5)`,
      `${quoteId}-item-${n}`, tenantId, description, n, quoteId,
    );
  }
  await raw.$executeRawUnsafe(
    `INSERT INTO "QuoteFee" ("id","tenantId","label","kind","amountCents","quoteId")
     VALUES ($1,$2,'probe delivery','delivery',25000,$3)`,
    `${quoteId}-fee`, tenantId, quoteId,
  );
  // CustomFieldDef.key is @@unique([entity, key]) with no tenant column, so the
  // key is randomised rather than named — two tenants cannot share one.
  await raw.$executeRawUnsafe(
    `INSERT INTO "CustomFieldDef" ("id","tenantId","entity","key","label","type","updatedAt")
     VALUES ($1,$2,'quote',$3,'Probe field','text',now())`,
    defId, tenantId, `probe_${label}_${defId.slice(-12)}`,
  );
  await raw.$executeRawUnsafe(
    `INSERT INTO "CustomFieldValue" ("id","tenantId","defId","recordId","value","updatedAt")
     VALUES ($1,$2,$3,$4,'probe value',now())`,
    `${quoteId}-cfv`, tenantId, defId, quoteId,
  );
  return { quoteId, defId, childCount: 4 };
}

/** Remove a planted quote, its revision, and everything hanging off both. */
async function dropPlantedQuote(raw: Raw, planted: PlantedQuote, revisionId: string | null): Promise<void> {
  const quoteIds = revisionId ? [planted.quoteId, revisionId] : [planted.quoteId];
  // CustomFieldValue cascades from the def, not from the quote — its recordId is
  // a bare string with no foreign key, so deleting the quote leaves it behind.
  await raw.$executeRawUnsafe(`DELETE FROM "CustomFieldDef" WHERE "id" = $1`, planted.defId).catch(() => 0);
  await raw.$executeRawUnsafe(`DELETE FROM "CustomFieldValue" WHERE "recordId" = ANY($1::text[])`, quoteIds).catch(() => 0);
  await raw.$executeRawUnsafe(`DELETE FROM "QuoteItem" WHERE "quoteId" = ANY($1::text[])`, quoteIds).catch(() => 0);
  await raw.$executeRawUnsafe(`DELETE FROM "QuoteFee" WHERE "quoteId" = ANY($1::text[])`, quoteIds).catch(() => 0);
  // Children first, then the revision, then the original it points at.
  if (revisionId) await raw.$executeRawUnsafe(`DELETE FROM "Quote" WHERE "id" = $1`, revisionId).catch(() => 0);
  await raw.$executeRawUnsafe(`DELETE FROM "Quote" WHERE "id" = $1`, planted.quoteId).catch(() => 0);
}

/**
 * The revision spawned from `originalId`, read through the BYPASS client.
 *
 * Deliberately NOT read back through the action layer or through a scoped list.
 * A wrongly-owned revision is invisible to a scoped read BY DEFINITION, so a
 * probe that looked for it there would report the exact defect it exists to
 * catch as "nothing was created" — a pass, or a skip. That mistake has already
 * produced two false results in this harness (SalesPipeline OWN, PipelineStage
 * OWN); it is the default failure mode here, not a remote possibility.
 */
async function revisionOf(raw: Raw, originalId: string): Promise<string | null> {
  const rows = await raw.$queryRawUnsafe(
    `SELECT "id" FROM "Quote" WHERE "revisionOfId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    originalId,
  );
  return rows.length ? rows[0].id : null;
}

/**
 * Every row in `targets` whose stored tenantId is not `expected`, described.
 *
 * Each target is [table, column, value] — a direct key lookup on the bypass
 * client. Returns one string per offending row so the failure names the table
 * and the value it actually holds, and reports a table with NO rows as its own
 * problem: a child set that came out empty means the copy never happened, and
 * "none of the rows are wrong" would be a true statement about nothing.
 */
async function misownedRows(
  raw: Raw,
  expected: string,
  targets: ReadonlyArray<readonly [string, string, string]>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const [table, column, value] of targets) {
    const rows = await raw.$queryRawUnsafe(
      `SELECT "id", "tenantId"::text AS v FROM "${table}" WHERE "${column}" = $1`,
      value,
    );
    if (rows.length === 0) {
      problems.push(`${table}: no rows found for ${column}=${value} — nothing was copied`);
      continue;
    }
    for (const row of rows as Array<{ id: string; v: string | null }>) {
      if (row.v !== expected) {
        problems.push(
          `${table} ${row.id} is owned by ${row.v === null ? "NOBODY (tenantId NULL)" : row.v}, expected ${expected}`,
        );
      }
    }
  }
  return problems;
}

async function countRows(raw: Raw, sql: string, ...values: unknown[]): Promise<number> {
  const rows = await raw.$queryRawUnsafe(sql, ...values);
  return Number(rows[0]?.n ?? 0);
}

async function ownedStageIds(raw: Raw, pipelineId: string): Promise<string[]> {
  const rows = await raw.$queryRawUnsafe(
    `SELECT "id" FROM "PipelineStage" WHERE "pipelineId" = $1`,
    pipelineId,
  );
  return rows.map((r: { id: string }) => r.id);
}

async function columnOf(raw: Raw, table: string, id: string, column: string): Promise<string | null | undefined> {
  const rows = await raw.$queryRawUnsafe(
    `SELECT "${column}"::text AS v FROM "${table}" WHERE "id" = $1`,
    id,
  );
  return rows.length ? rows[0].v : undefined;
}
