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

const brief = (e: unknown) => {
  const x = e as { name?: string; message?: string };
  return `${x?.name ?? "Error"}: ${(x?.message ?? String(e)).slice(0, 80)}`;
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

  return out;
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
