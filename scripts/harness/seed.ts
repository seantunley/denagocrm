/**
 * TWO TENANTS, EACH WITH A REALISTIC SPREAD OF RECORDS.
 *
 * Seeding is done through `basePrisma` (the trusted bypass client) with an
 * EXPLICIT tenantId on every row. That is deliberate and it is the opposite of
 * what the harness then tests.
 *
 * The rows here represent a CORRECTLY OWNED world — the state production would
 * be in immediately after a clean backfill, where every row knows which tenant it
 * belongs to. Seeding through the action layer instead would mean seeding through
 * the very code whose ownership behaviour is under test, and any model whose
 * action forgets to stamp `tenantId` would produce an unowned row that then
 * "correctly" fails to leak — a false pass, which is the exact failure mode this
 * whole exercise exists to eliminate.
 *
 * So: the fixture is clean by construction, and every question about whether the
 * application maintains that cleanliness is asked afterwards, through the actions.
 */
import crypto from "node:crypto";
import { basePrisma } from "../../src/lib/db";
import { signFreshSession } from "../../src/lib/session";
import { PERMISSIONS } from "../../src/lib/permissions";
import type { ActingSession } from "./actingSession";

/** Rows this harness plants, per tenant, addressable by the matrix. */
export type SeededRows = {
  pipelineId: string;
  /**
   * A SECOND pipeline with no leads and no stages, used only by the archive
   * probe. `archivePipeline()` refuses any pipeline that still has leads — a
   * business rule, not a tenant boundary — so archiving the main fixture
   * pipeline is refused for the wrong reason and reads as a pass. That is a
   * false pass, and a false pass in an isolation suite is worse than no check.
   */
  archivePipelineId: string;
  stageId: string;
  contactId: string;
  leadId: string;
  quoteId: string;
  dashboardId: string;
  dashboardSlug: string;
  timelinePinId: string;
  activityId: string;
  flowId: string;
  journeyId: string;
  journeyVersionId: string;
  journeyRunId: string;
  journeyStepLogId: string;
  /**
   * A run in `failed`, for the JourneyRun UPDATE probe.
   *
   * The `running` fixture run above CANNOT serve it. `retryJourneyRun` opens
   * with `if (!["failed","cancelled"].includes(run.status)) throw` — so aiming
   * the probe at a running row means the action refuses on a BUSINESS rule
   * before it ever reaches a tenant decision, and the engine, which judges the
   * row and not the message, records that refusal as the boundary holding. It
   * is the same false pass the PipelineStage LIST probe was caught in, arriving
   * from the other direction: not "the query could not have seen B's rows" but
   * "the action never got as far as looking".
   *
   * Its (journeyId, entityType, entityId) triple is UNIQUE to it, because
   * retryJourneyRun's second gate refuses a run that has been superseded by any
   * OPEN run on the same triple — and the fixture's `running` run is open.
   * Sharing the triple would have swapped one business-rule false pass for
   * another.
   */
  journeyRunFailedId: string;
  /**
   * A THIRD failed run, with a failed step log of its own, so the
   * JourneyStepLog DELETE probe has a target that JourneyRun's UPDATE probe has
   * not already consumed — both drive `retryJourneyRun`, and it deletes the
   * step logs of whatever run it retries. Sharing one run would leave the
   * second probe reporting "B's row was already gone", i.e. a skip dressed as
   * coverage.
   */
  journeyRunRetryId: string;
  journeyStepLogRetryId: string;
  /** Queued and due, so `processOneRun` will actually execute it. */
  journeyRunQueuedId: string;
  testDriveId: string;
  partId: string;
  vehicleId: string;
  jobCardId: string;
  consentRecordId: string;
};

export type TenantFixture = {
  key: "A" | "B";
  tenantId: string;
  /** Non-owner user holding every permission via a tenant-owned Role. */
  memberUserId: string;
  memberSession: ActingSession;
  /** Global `owner` user, for the handful of actions gated on requireOwner(). */
  ownerUserId: string;
  ownerSession: ActingSession;
  rows: SeededRows;
};

export type Fixture = {
  suffix: string;
  a: TenantFixture;
  b: TenantFixture;
};

/**
 * `withTenantWrite()` falls back to DEFAULT_TENANT_ID whenever it is dormant, so
 * this row has to exist or contact/lead writes fail on a foreign key during the
 * dormant pass — for reasons that have nothing to do with isolation.
 */
const DEFAULT_TENANT_ID = "tenant_denago_cpt";

const uid = () => crypto.randomUUID();

async function exec(sql: string, ...values: unknown[]): Promise<void> {
  await basePrisma.$executeRawUnsafe(sql, ...values);
}

/**
 * Session cookie for a seeded user, minted by the application's OWN signer with
 * the application's own claims. Nothing here is a shortcut: `getCurrentUser()`
 * runs its real `jwtVerify`, its real `sessionVersion` comparison and its real
 * tenant-scope establishment against this token. `jti` is deliberately omitted so
 * no `UserSession` registry row is required — a session without a jti is a shape
 * the app already supports (see the `if (session.jti)` branch in auth.ts).
 */
async function mintSession(
  user: { id: string; name: string; email: string; role: string },
  tenantId: string,
  label: string,
): Promise<ActingSession> {
  const cookieValue = await signFreshSession(
    { ...user, grants: "", sessionVersion: 0 },
    60,
    // `tid` is the claim establishStaffTenantScope honours under enforcement.
    // Present in both modes because a real browser session carries it in both.
    { tid: tenantId },
  );
  return { cookieValue, label };
}

/** The Permission catalogue is global (one taxonomy, shared by every tenant). */
async function seedPermissionCatalogue(): Promise<void> {
  for (const key of PERMISSIONS) {
    await exec(
      `INSERT INTO "Permission" ("key","description","category")
       VALUES ($1,$2,$3) ON CONFLICT ("key") DO NOTHING`,
      key,
      `harness ${key}`,
      "harness",
    );
  }
}

async function seedTenant(key: "A" | "B", suffix: string): Promise<TenantFixture> {
  const tenantId = `harness_${key}_${suffix}`;
  const rows: SeededRows = {
    pipelineId: uid(),
    archivePipelineId: uid(),
    stageId: uid(),
    contactId: uid(),
    leadId: uid(),
    quoteId: uid(),
    dashboardId: uid(),
    dashboardSlug: `board-${key.toLowerCase()}-${suffix}`,
    timelinePinId: uid(),
    activityId: uid(),
    flowId: uid(),
    journeyId: uid(),
    journeyVersionId: uid(),
    journeyRunId: uid(),
    journeyStepLogId: uid(),
    journeyRunFailedId: uid(),
    journeyRunRetryId: uid(),
    journeyStepLogRetryId: uid(),
    journeyRunQueuedId: uid(),
    testDriveId: uid(),
    partId: uid(),
    vehicleId: uid(),
    jobCardId: uid(),
    consentRecordId: uid(),
  };

  await exec(
    `INSERT INTO "Tenant" ("id","name","slug","active","modules")
     VALUES ($1,$2,$3,true,$4)`,
    tenantId,
    `Harness ${key}`,
    tenantId,
    // Every optional pack granted: a module that is merely OFF would make an
    // action refuse for a reason unrelated to tenancy, which reads as a pass.
    "inbox,marketing,automotive,workshop,reports",
  );

  const memberUserId = uid();
  const ownerUserId = uid();
  for (const [id, role] of [[memberUserId, "member"], [ownerUserId, "owner"]] as const) {
    await exec(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","sessionVersion")
       VALUES ($1,$2,$3,$4,$5,0)`,
      id,
      `Harness ${key} ${role}`,
      `${role}.${key.toLowerCase()}.${suffix}@harness.invalid`,
      "not-a-real-hash",
      role,
    );
    await exec(
      `INSERT INTO "TenantMember" ("id","tenantId","userId") VALUES ($1,$2,$3)`,
      uid(),
      tenantId,
      id,
    );
  }

  // A TENANT-OWNED ROLE holding every permission key.
  //
  // The member user is NOT a global owner, on purpose: `hasPermission` returns
  // true for an owner without reading anything, so an owner-only harness would
  // never exercise the RBAC query — and getUserPermissions is itself
  // tenant-filtered under enforcement, which is a boundary worth testing rather
  // than skipping. Granting every key keeps the RBAC path live while making sure
  // no assertion fails merely because a permission was missing.
  const roleId = uid();
  await exec(
    `INSERT INTO "Role" ("id","tenantId","name","description","system","updatedAt")
     VALUES ($1,$2,$3,$4,false,now())`,
    roleId,
    tenantId,
    `Harness ${key} full`,
    "harness fixture role",
  );
  for (const key2 of PERMISSIONS) {
    await exec(
      `INSERT INTO "RolePermission" ("roleId","permissionKey","tenantId") VALUES ($1,$2,$3)`,
      roleId,
      key2,
      tenantId,
    );
  }
  await exec(
    `INSERT INTO "UserRole" ("id","userId","roleId","tenantId") VALUES ($1,$2,$3,$4)`,
    uid(),
    memberUserId,
    roleId,
    tenantId,
  );

  await seedBusinessRows(tenantId, rows, memberUserId, key);

  return {
    key,
    tenantId,
    memberUserId,
    memberSession: await mintSession(
      { id: memberUserId, name: `Harness ${key} member`, email: `member.${key.toLowerCase()}.${suffix}@harness.invalid`, role: "member" },
      tenantId,
      `${key}/member`,
    ),
    ownerUserId,
    ownerSession: await mintSession(
      { id: ownerUserId, name: `Harness ${key} owner`, email: `owner.${key.toLowerCase()}.${suffix}@harness.invalid`, role: "owner" },
      tenantId,
      `${key}/owner`,
    ),
    rows,
  };
}

async function seedBusinessRows(
  tenantId: string,
  rows: SeededRows,
  userId: string,
  key: "A" | "B",
): Promise<void> {
  // Pipeline + a non-closed stage.
  //
  // NEITHER TENANT'S PIPELINE IS THE DEFAULT, and that is not a modelling choice
  // — it is forced, twice over.
  //
  // `SalesPipeline_single_default_key` is UNIQUE on ("isDefault") WHERE
  // isDefault = true AND deletedAt IS NULL, with no tenant column in it: exactly
  // ONE default pipeline may exist in the entire database. And the slot is
  // already occupied before any tenant is created, because migration-seeded data
  // plants `pipeline_default_retail` for the founding tenant. So a second
  // workspace cannot have a default pipeline at all — not "if it picks the same
  // name", simply cannot. The name is globally unique on the same terms
  // (`SalesPipeline_name_key` on (name) WHERE deletedAt IS NULL), which is why
  // these are named per tenant rather than both being "Sales".
  //
  // The fixture works around both so the rest of the suite can run; the
  // constraints are asserted head-on by the UNIQUE probes in defects.ts, where
  // they are meant to fail loudly rather than be quietly designed around here.
  await exec(
    `INSERT INTO "SalesPipeline" ("id","tenantId","name","description","type","active","isDefault","updatedAt")
     VALUES ($1,$2,$3,$4,'sales',true,false,now())`,
    rows.pipelineId,
    tenantId,
    `${key} pipeline ${tenantId.slice(-8)}`,
    `owned by ${tenantId}`,
  );
  // Leadless, stageless — see SeededRows.archivePipelineId for why it exists.
  await exec(
    `INSERT INTO "SalesPipeline" ("id","tenantId","name","description","type","active","isDefault","updatedAt")
     VALUES ($1,$2,$3,$4,'sales',true,false,now())`,
    rows.archivePipelineId,
    tenantId,
    `${key} archivable ${tenantId.slice(-8)}`,
    `archive probe target for ${tenantId}`,
  );
  await exec(
    `INSERT INTO "PipelineStage" ("id","tenantId","name","order","color","pipelineId","defaultProbability","isClosed")
     VALUES ($1,$2,$3,0,'#64748b',$4,10,false)`,
    rows.stageId,
    tenantId,
    `${key} stage`,
    rows.pipelineId,
  );

  await exec(
    `INSERT INTO "Contact" ("id","tenantId","firstName","lastName","company","email","notes","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
    rows.contactId,
    tenantId,
    `${key}First`,
    `${key}Last`,
    `${key} Holdings`,
    `contact.${key.toLowerCase()}@harness.invalid`,
    `original note for ${key}`,
  );

  await exec(
    `INSERT INTO "Lead" ("id","tenantId","title","name","status","stageId","pipelineId","contactId","assignedToId","createdById","notes","valueCents","updatedAt")
     VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$8,$9,100000,now())`,
    rows.leadId,
    tenantId,
    `${key} lead`,
    `${key} Buyer`,
    rows.stageId,
    rows.pipelineId,
    rows.contactId,
    userId,
    `original lead note for ${key}`,
  );

  // Quote.number is globally unique, so it is derived from the id rather than a
  // per-tenant counter — the tenant-scoped numbering swap is a separate PR.
  const quoteNumber = Math.abs(hash32(rows.quoteId)) % 2_000_000_000;
  await exec(
    `INSERT INTO "Quote" ("id","tenantId","number","status","contactId","leadId","terms","updatedAt")
     VALUES ($1,$2,$3,'draft',$4,$5,$6,now())`,
    rows.quoteId,
    tenantId,
    quoteNumber,
    rows.contactId,
    rows.leadId,
    `${key} terms`,
  );

  await exec(
    `INSERT INTO "Dashboard" ("id","tenantId","userId","slug","title","sortOrder","config","updatedAt")
     VALUES ($1,$2,$3,$4,$5,0,$6::jsonb,now())`,
    rows.dashboardId,
    tenantId,
    userId,
    rows.dashboardSlug,
    `${key} dashboard`,
    JSON.stringify({ title: `${key} dashboard`, slug: rows.dashboardSlug, widgets: [] }),
  );

  // An Activity to hang a TimelinePin on — the pin actions toggle by item id.
  await exec(
    `INSERT INTO "Activity" ("id","tenantId","type","summary","dueDate","leadId","contactId","assignedToId","createdById")
     VALUES ($1,$2,'note',$3,now(),$4,$5,$6,$6)`,
    rows.activityId,
    tenantId,
    `${key} activity`,
    rows.leadId,
    rows.contactId,
    userId,
  );
  await exec(
    `INSERT INTO "TimelinePin" ("id","tenantId","kind","itemId","pinnedById")
     VALUES ($1,$2,'activity',$3,$4)`,
    rows.timelinePinId,
    tenantId,
    rows.activityId,
    userId,
  );

  await exec(
    `INSERT INTO "BotFlow" ("id","tenantId","name","definition","active","updatedAt")
     VALUES ($1,$2,$3,$4,false,now())`,
    rows.flowId,
    tenantId,
    `${key} flow`,
    JSON.stringify({ start: "s1", nodes: { s1: { type: "message", text: key } } }),
  );

  /* The journey is ACTIVE with a PUBLISHED version, and its definition is a real
   * (if trivial) one-step script — `add_tag` with no tag configured, which the
   * executor reports as `skipped` after touching nothing.
   *
   * All three properties are load-bearing and none of them is decoration:
   *
   *   - ACTIVE + PUBLISHED is what `enrollEntityInJourney` requires, so the
   *     JourneyRun OWN probe can create a run through the application instead of
   *     being skipped for want of one. JourneyRun is 6/6 unowned in production;
   *     "no create probe supplied" is precisely the coverage hole that let that
   *     ship.
   *   - A PARSEABLE definition with a start step is what `processOneRun` needs
   *     to reach `updateStepLog`, which is the only place a JourneyStepLog row
   *     is ever written. Without it the JourneyStepLog OWN probe cannot exist.
   *   - A step that DOES NOTHING keeps the probe about ownership. `send_email`
   *     or `send_sms` would drag a provider into an isolation test and fail for
   *     reasons that have nothing to do with tenancy.
   */
  const journeyDefinition = JSON.stringify({
    startStepId: "probe_step",
    steps: [{ id: "probe_step", type: "add_tag", name: "harness no-op", config: {} }],
  });
  await exec(
    `INSERT INTO "Journey" ("id","tenantId","name","status","activeVersion","updatedAt")
     VALUES ($1,$2,$3,'active',1,now())`,
    rows.journeyId,
    tenantId,
    `${key} journey`,
  );
  await exec(
    `INSERT INTO "JourneyVersion" ("id","tenantId","journeyId","version","state","trigger","definition","triggers","createdAt")
     VALUES ($1,$2,$3,1,'published','manual',$4::jsonb,$5::jsonb,now())`,
    rows.journeyVersionId,
    tenantId,
    rows.journeyId,
    journeyDefinition,
    JSON.stringify([]),
  );
  await exec(
    `INSERT INTO "JourneyRun" ("id","tenantId","journeyId","journeyVersionId","status","entityType","entityId","leadId","context","idempotencyKey","updatedAt")
     VALUES ($1,$2,$3,$4,'running','lead',$5,$5,$6::jsonb,$7,now())`,
    rows.journeyRunId,
    tenantId,
    rows.journeyId,
    rows.journeyVersionId,
    rows.leadId,
    JSON.stringify({}),
    `harness-${rows.journeyRunId}`,
  );
  await exec(
    `INSERT INTO "JourneyStepLog" ("id","tenantId","runId","path","stepId","stepType","status")
     VALUES ($1,$2,$3,$4,$4,'message','done')`,
    rows.journeyStepLogId,
    tenantId,
    rows.journeyRunId,
    `${key}-step`,
  );

  // Two FAILED runs, each on its own (journeyId, entityType, entityId) triple —
  // see SeededRows for why the status and the triple both matter. `entityId` is
  // a synthetic string rather than a real contact: nothing on the retry path
  // resolves it, and a distinct value is the cheapest way to guarantee the
  // superseded-run gate cannot fire.
  for (const [runId, entitySuffix] of [
    [rows.journeyRunFailedId, "retryprobe"],
    [rows.journeyRunRetryId, "steplogprobe"],
  ] as const) {
    await exec(
      `INSERT INTO "JourneyRun" ("id","tenantId","journeyId","journeyVersionId","status","entityType","entityId","context","idempotencyKey","lastError","updatedAt")
       VALUES ($1,$2,$3,$4,'failed','contact',$5,$6::jsonb,$7,'seeded as failed',now())`,
      runId,
      tenantId,
      rows.journeyId,
      rows.journeyVersionId,
      `${tenantId}-${entitySuffix}`,
      JSON.stringify({}),
      `harness-${runId}`,
    );
  }
  // `retryJourneyRun` deletes step logs whose status is running or failed, so
  // the target row must be one of those or the DELETE probe would pass because
  // the deleteMany's OWN where clause excluded it — a false pass with nothing
  // to do with tenancy.
  await exec(
    `INSERT INTO "JourneyStepLog" ("id","tenantId","runId","path","stepId","stepType","status")
     VALUES ($1,$2,$3,$4,$4,'message','failed')`,
    rows.journeyStepLogRetryId,
    tenantId,
    rows.journeyRunRetryId,
    `${key}-retry-step`,
  );

  // Queued and due — `processOneRun` claims exactly this shape.
  await exec(
    `INSERT INTO "JourneyRun" ("id","tenantId","journeyId","journeyVersionId","status","entityType","entityId","leadId","contactId","context","idempotencyKey","nextRunAt","updatedAt")
     VALUES ($1,$2,$3,$4,'queued','lead',$5,$5,$6,$7::jsonb,$8,now() - interval '1 minute',now())`,
    rows.journeyRunQueuedId,
    tenantId,
    rows.journeyId,
    rows.journeyVersionId,
    rows.leadId,
    rows.contactId,
    JSON.stringify({}),
    `harness-${rows.journeyRunQueuedId}`,
  );

  await exec(
    `INSERT INTO "TestDriveBooking" ("id","tenantId","reference","status","contactId","branch","salespersonId","scheduledStart","expectedReturnAt","updatedAt")
     VALUES ($1,$2,$3,'booked',$4,$5,$6,now(),now() + interval '1 hour',now())`,
    rows.testDriveId,
    tenantId,
    `TD-${key}-${rows.testDriveId.slice(0, 8)}`,
    rows.contactId,
    `${key} branch`,
    userId,
  );

  await exec(
    `INSERT INTO "Part" ("id","tenantId","name","sku","stockQty")
     VALUES ($1,$2,$3,$4,25)`,
    rows.partId,
    tenantId,
    `${key} part`,
    `SKU-${key}-${rows.partId.slice(0, 8)}`,
  );

  // Vehicle + JobCard + ConsentRecord.
  //
  // These three are the regression PR #430's reviewer is holding approval for:
  // a convincingly WRONG tenant id being persisted. JobCard.number is globally
  // unique, so it is derived from the id rather than counted.
  await exec(
    `INSERT INTO "Vehicle" ("id","tenantId","model","regNumber","contactId")
     VALUES ($1,$2,$3,$4,$5)`,
    rows.vehicleId,
    tenantId,
    `${key} cart`,
    `REG-${key}-${rows.vehicleId.slice(0, 6)}`,
    rows.contactId,
  );
  await exec(
    `INSERT INTO "JobCard" ("id","tenantId","number","status","description","vehicleId","contactId","updatedAt")
     VALUES ($1,$2,$3,'booking',$4,$5,$6,now())`,
    rows.jobCardId,
    tenantId,
    Math.abs(hash32(rows.jobCardId)) % 2_000_000_000,
    `${key} job card`,
    rows.vehicleId,
    rows.contactId,
  );
  await exec(
    `INSERT INTO "ConsentRecord" ("id","tenantId","type","granted","source","contactId","createdById")
     VALUES ($1,$2,'marketing',true,'admin',$3,$4)`,
    rows.consentRecordId,
    tenantId,
    rows.contactId,
    userId,
  );
}

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * Delete anything left behind by a previous harness run.
 *
 * Not merely tidiness. `SalesPipeline_single_default_key` permits ONE default
 * pipeline in the whole database, so a single orphaned fixture row from a run
 * that crashed before teardown makes every subsequent run fail at seed time with
 * a unique-violation that looks nothing like the constraint it actually is. Every
 * row this harness creates is identifiable by its `harness_` tenant id prefix.
 */
async function purgeLeftovers(): Promise<void> {
  const tables = [
    "JourneyStepLog", "JourneyRun", "JourneyVersion", "Journey",
    "TimelinePin", "Activity", "TestDriveBooking",
    "JobCardItem", "JobCard", "Vehicle", "ConsentRecord",
    "QuoteItem", "Quote", "Lead", "Contact",
    "PipelineStage", "SalesPipeline", "Dashboard", "BotFlow", "Part",
    "AuditEvent", "AuditLog", "ForecastSnapshot",
    "UserRole", "RolePermission", "Role",
  ];
  for (const table of tables) {
    await basePrisma
      .$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" LIKE 'harness\\_%'`)
      .catch(() => 0);
  }
  await basePrisma
    .$executeRawUnsafe(`DELETE FROM "TenantMember" WHERE "tenantId" LIKE 'harness\\_%'`)
    .catch(() => 0);
  await basePrisma
    .$executeRawUnsafe(`DELETE FROM "User" WHERE "email" LIKE '%@harness.invalid'`)
    .catch(() => 0);
  await basePrisma
    .$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" LIKE 'harness\\_%'`)
    .catch(() => 0);
}

export async function seedTwoTenants(suffix: string): Promise<Fixture> {
  await purgeLeftovers();
  await exec(
    `INSERT INTO "Tenant" ("id","name","slug","active","modules")
     VALUES ($1,$2,$3,true,$4) ON CONFLICT ("id") DO NOTHING`,
    DEFAULT_TENANT_ID,
    "Default (withTenantWrite fallback)",
    DEFAULT_TENANT_ID,
    "inbox,marketing,automotive,workshop,reports",
  );
  await seedPermissionCatalogue();
  return { suffix, a: await seedTenant("A", suffix), b: await seedTenant("B", suffix) };
}

/**
 * Remove everything this run planted.
 *
 * Ordered child-before-parent because the scratch database has real foreign
 * keys, and driven off the tenant ids rather than off the recorded row ids: an
 * action under test may legitimately have created rows the fixture never knew
 * about, and those must go too.
 */
export async function teardown(fixture: Fixture): Promise<void> {
  const ids = [fixture.a.tenantId, fixture.b.tenantId];
  const byTenant = [
    "JourneyStepLog", "JourneyRun", "JourneyVersion", "Journey",
    "TimelinePin", "Activity", "TestDriveBooking",
    "JobCardItem", "JobCard", "Vehicle", "ConsentRecord",
    "QuoteItem", "Quote", "Lead", "Contact",
    "PipelineStage", "SalesPipeline", "Dashboard", "BotFlow", "Part",
    "AuditEvent", "AuditLog", "ForecastSnapshot",
    "UserRole", "RolePermission", "Role",
  ];
  for (const table of byTenant) {
    await basePrisma
      .$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenantId" = ANY($1::text[])`, ids)
      .catch(() => 0);
  }
  const userIds = [
    fixture.a.memberUserId, fixture.a.ownerUserId,
    fixture.b.memberUserId, fixture.b.ownerUserId,
  ];
  for (const table of ["UserRole", "TenantMember", "UserSession"]) {
    await basePrisma
      .$executeRawUnsafe(`DELETE FROM "${table}" WHERE "userId" = ANY($1::text[])`, userIds)
      .catch(() => 0);
  }
  await basePrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, userIds).catch(() => 0);
  await basePrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])`, ids).catch(() => 0);
}
