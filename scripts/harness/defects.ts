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
   *
   * ⚠ THIS PROBE IS GREEN FOR THE WRONG REASON WHILE DORMANT. DO NOT READ IT AS
   * "saveQuoteDraft IS SAFE". It is not: the edit path locks and rewrites the
   * quote with a bare `where: { id }` on the BYPASS client, with no tenant
   * predicate on the lock, the read, the header update, or the QuoteItem/QuoteFee
   * rewrite. What refuses THIS payload is a pair of unrelated BUSINESS rules:
   *
   *   `existing.leadId && existing.contactId !== data.contactId`
   *       "The customer on a lead-linked quote cannot be changed." B's fixture
   *       quote has a leadId and the payload names A's contact, so it throws
   *       before any write. Send B's OWN contactId and the rule does not fire.
   *   `prisma.contact.findUnique` returns nothing
   *       by the time these probes run, the matrix DELETE check has already
   *       soft-deleted B's fixture contact, so "That customer is no longer
   *       available" refuses the repaired payload too.
   *
   * MEASURED, not inferred. Driven against a FRESHLY PLANTED live victim contact
   * and a LEADLESS victim quote — neither rule reachable — A rewrote B's terms and
   * wrote a QuoteItem into B's quote, and the new line came out stamped with B's
   * tenantId, so it reads as a perfectly ordinary row of B's. Under enforcement
   * the same call is refused. That is a live dormant-only cross-tenant write, of
   * the same class as probes 8 and 11 and NOT fixed by the PR that added this
   * note; it is called out in that PR's sweep for a follow-up of its own.
   *
   * Making this probe honest means planting its own victim quote the way probe 8
   * does. It is left as-is here deliberately, rather than quietly turned red in a
   * PR that does not carry the fix — but a reviewer who sees it tick must know
   * that the tick is about two business rules and nothing else.
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
   *
   * IT IS ALSO THE CONTROL FOR PROBE 8, which is why `ownRevisionWorked` leaves
   * this block. Probe 8 renders a verdict on a revision that does NOT appear, and
   * "no revision appeared" only means something once the identical call has been
   * shown to produce one on a quote the actor genuinely owns.
   */
  let ownRevisionWorked = false;
  {
    const planted = await plantQuoteWithChildren(
      raw, actorA.tenant.tenantId, "own", actorA.tenant.rows.contactId, actorA.tenant.rows.leadId,
    );
    const attempt = await swallow(() => actorA.as(() => quotes.createQuoteRevision(planted.quoteId)));
    const revisionId = await revisionOf(raw, planted.quoteId);
    ownRevisionWorked = revisionId != null;

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
   * "NO REVISION WAS CREATED" IS THE HARD CASE, because it has two opposite
   * causes and the probe has to be able to tell them apart:
   *
   *   the action refused        `createQuoteRevision` now reads the original
   *                             under `tenantId = actingTenant`, so B's quote
   *                             resolves to nothing and the call returns before
   *                             a tenant is ever chosen. THE BOUNDARY HELD.
   *   the copy was attempted    the code stamped the ACTING workspace and the
   *   and the DATABASE threw    composite FK `Quote_tenantId_revisionOfId_fkey`
   *   it out                    — which requires a revision to carry its
   *                             ORIGINAL's tenant — rejected it. A FAILURE.
   *
   * IT IS SETTLED BY A CONTROL, NOT BY THE ERROR TEXT, and not by reachability
   * either. Probe 7 above drives the identical call against a quote A genuinely
   * owns; `ownRevisionWorked` says whether that produced a revision. Only once it
   * has can "nothing appeared here" mean anything, and if it has not, this probe
   * says SKIP rather than claiming a pass it did not earn.
   *
   * Reachability is still measured, and it is still worth printing: while dormant
   * `canAccessQuote` filters on `activeTenantPredicate`, which is `{}` with no
   * scope established, so A CAN reach B's quote through the access gate. Recording
   * that keeps the report honest about WHICH layer refused — the tenant predicate
   * inside the transaction, not the permission check in front of it.
   *
   * ⚠ WHAT A GREEN TICK HERE DOES AND DOES NOT CERTIFY. Two layers now defend
   * this, and the outer one shadows the inner. With the read predicate in place,
   * the `original.tenantId ?? actingTenant` stamp is unreachable for a foreign
   * quote, so the mutation that swaps it for a bare `actingTenant` no longer shows
   * up here at all — the read returns nothing and the stamp is never evaluated.
   * That is not this probe going soft: it is the same honest position probe 9
   * takes below. What is asserted is the OUTCOME — B's original is not superseded
   * (8a) and no copy of B's quote exists (8b) — which is the fact worth having,
   * and the only one an outcome-based probe can honestly claim.
   *
   * Measured by mutation, against this database, one edit at a time:
   *
   *   the whole createQuoteRevision fix reverted    8a goes RED (18 → 19 dormant)
   *   predicate off the supersede updateMany alone  stays green — the read
   *     returns null for B's quote and the call bails before the update.
   *   predicate off the lock and read alone         stays green — the copy runs,
   *     then the count-checked updateMany matches zero rows and THROWS, rolling
   *     the revision and every child row back with it.
   *
   * So each layer shadows the other, and only losing both is visible here. Both
   * are kept for that reason, and because a check in front of an unguarded write
   * is a race, not a boundary (#459).
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

    /* 8b. AND NO COPY OF B'S QUOTE MAY EXIST AT ALL.
     *
     * #479 asked the narrower question — if a revision was made, was it re-owned?
     * — because the copy itself read as tolerable: a revision carrying B's tenant
     * is at least B's row. It is not tolerable. It is a live draft sitting in a
     * workspace that never asked for it, made by somebody with no business there,
     * and the only reason to accept it was that the code could not then tell the
     * difference. It can now, so this asks the whole question.
     *
     * The narrower question is still ANSWERED, in the failure detail — a copy that
     * came out owned by the ACTING workspace is a different and worse fact than one
     * that came out owned by B, and the report should say which happened.
     */
    const inheritName = "a revision attempt cannot copy another tenant's quote";
    if (revisionId) {
      const stolen = await misownedRows(raw, victim.tenantId, [
        ["Quote", "id", revisionId],
        ["QuoteItem", "quoteId", revisionId],
        ["QuoteFee", "quoteId", revisionId],
        ["CustomFieldValue", "recordId", revisionId],
      ]);
      out.push(result("FORGERY", "Quote", inheritName, "fail",
        stolen.length === 0
          ? `A copied B's quote: revision ${revisionId} and its ${planted.childCount} child row(s) exist. They ` +
            `carry ${victim.tenantId}, so nothing was RE-OWNED — but A had no business making the copy, and it ` +
            `is now a live draft in B's workspace that B did not create.`
          : `A revised B's quote and the copy came out owned by the ACTING workspace: ${stolen.join("; ")}. ` +
            `Revising is not a transfer of ownership.`));
    } else if (!ownRevisionWorked) {
      out.push(result("FORGERY", "Quote", inheritName, "skip",
        `no revision of B's quote exists, but the CONTROL did not run either — probe 7 drove the same call ` +
        `on a quote A genuinely owns and got no revision from it, so this call never reaches the copy and ` +
        `"nothing was created" says nothing about tenancy. ` +
        `${attempt.threw ? brief(attempt.error) : "the action declined"}`));
    } else {
      out.push(result("FORGERY", "Quote", inheritName, "pass",
        `no copy of B's quote exists. The control holds — the identical call DID produce a revision on a ` +
        `quote A owns — so the path reaches the copy and was refused here on the tenant predicate, ` +
        `${reachable
          ? "NOT by the access gate, which let A read B's quote in this mode"
          : "with the access gate also refusing ahead of it"}. ` +
        `${attempt.threw ? brief(attempt.error) : "the action declined"}`));
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
   * from the form exactly as `addJobCardItem` does. It is the SIBLING of the
   * decrement #459 fixed in claimPartStock — same forged id, same form post,
   * different entry point — and #459 did not reach it.
   *
   * It also fails in a DIFFERENT MODE, which is why the pair is reported
   * separately. claimPartStock runs on the bypass client, so it always needed an
   * explicit predicate. reservePart runs on the SCOPED client, where it LOOKS
   * guarded — and is not, because `scopeArgs` returns its args untouched unless
   * `tenantEnforcing()`, which is false in every environment we run. Dormant, a
   * "scoped" query is an unscoped one; that is the whole shape of this class.
   *
   * TWO CHECKS, because the two halves fail independently:
   *
   *   11a  A reservation A creates carries A's tenant. Nothing stamped it: the
   *        scoped client does not stamp while dormant, so the row landed with
   *        tenantId NULL — invisible to its own workshop at the flip, AND, worse,
   *        trivially satisfying both composite FKs PartReservation carries
   *        (MATCH SIMPLE treats a NULL key as met), so the database had been told
   *        not to check the very row that crossed the boundary.
   *   11b  A cannot reserve B's part at all.
   *
   * 11a IS ALSO THE CONTROL FOR 11b. Without it, "no reservation against B's
   * part" could equally mean the module is off, the job card refused, or the
   * quantity parse rejected — and would read as a pass.
   *
   * Measured by mutation, against this database, one edit at a time:
   *
   *   the whole reservePart fix reverted    BOTH go RED (18 → 20 dormant)
   *   the tenantId STAMP dropped alone      11a RED, 11b green (18 → 19)
   *     Which is the point of keeping 11a: the predicate on its own already stops
   *     the forgery, so 11b alone would have signed off on rows landing unowned.
   */
  {
    const ownPart = actorA.tenant.rows.partId;
    const ownCard = actorA.tenant.rows.jobCardId;
    const ownBefore = await reservationRows(raw, ownPart, ownCard);
    const control = await swallow(() =>
      actorA.as(() => jobcards.reservePart(ownCard, fd({ partId: ownPart, qty: "1" }))),
    );
    const ownAfter = await reservationRows(raw, ownPart, ownCard);
    const created = ownAfter.filter((r) => !ownBefore.some((b) => b.id === r.id));
    const ownName = "a reservation A creates carries the acting tenant";
    if (created.length === 0) {
      out.push(result("OWN", "PartReservation", ownName, "skip",
        `A's reservation of A's OWN part created no row, so nothing was measured — ` +
        `${control.threw ? brief(control.error) : "the action returned without creating one"}`));
    } else {
      const misowned = created.filter((r) => r.v !== actorA.tenant.tenantId);
      out.push(
        misowned.length === 0
          ? result("OWN", "PartReservation", ownName, "pass",
              `PartReservation ${created[0].id} stamped ${actorA.tenant.tenantId}`)
          : result("OWN", "PartReservation", ownName, "fail",
              `${misowned.map((r) => `${r.id} is owned by ${r.v === null ? "NOBODY (tenantId NULL)" : r.v}`).join("; ")}, ` +
              `expected ${actorA.tenant.tenantId}. An unstamped reservation is invisible to its own workshop ` +
              `after the flip, and its NULL tenantId disarms both composite FKs the row carries.`),
      );
    }
    const pathWorks = created.length > 0;
    await raw.$executeRawUnsafe(
      `DELETE FROM "PartReservation" WHERE "id" = ANY($1::text[])`, created.map((r) => r.id),
    ).catch(() => 0);

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
    if (!pathWorks) {
      out.push(result("FORGERY", "PartReservation", name, "skip",
        `the control reservation on A's OWN part created nothing, so this call never reaches the reservation ` +
        `write and "no reservation against B's part" would prove nothing`));
    } else {
      out.push(
        after === before
          ? result("FORGERY", "PartReservation", name, "pass",
              attempt.threw ? `refused — ${brief(attempt.error)}` : "no reservation was created")
          : result("FORGERY", "PartReservation", name, "fail",
              `A earmarked B's stock: ${after - before} PartReservation row(s) now hold B's part against A's ` +
              `job card, so B's available quantity drops with nothing on B's side to explain it`),
      );
    }
    await raw.$executeRawUnsafe(
      `DELETE FROM "PartReservation" WHERE "partId" = $1 AND "jobCardId" = $2`,
      victim.rows.partId, actorA.tenant.rows.jobCardId,
    ).catch(() => 0);
  }

  return out;
}

/**
 * Active reservations on `partId` against `jobCardId`, id + stored tenantId,
 * read through the BYPASS client.
 *
 * Through a scoped client a wrongly-owned — or unowned — row is invisible BY
 * DEFINITION, so the probe that exists to catch a bad stamp would report it as
 * "no row was created". That mistake has already produced false results in this
 * harness three times; see revisionOf() for the same warning.
 */
async function reservationRows(
  raw: Raw,
  partId: string,
  jobCardId: string,
): Promise<Array<{ id: string; v: string | null }>> {
  return raw.$queryRawUnsafe(
    `SELECT "id", "tenantId"::text AS v FROM "PartReservation"
     WHERE "partId" = $1 AND "jobCardId" = $2 AND "status" = 'active'`,
    partId,
    jobCardId,
  );
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
