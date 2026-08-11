/**
 * THE BOT CONVERSATION, DRIVEN THROUGH THE REAL CHANNEL SCOPE, FOR TWO TENANTS.
 *
 * The rest of this harness drives staff SESSIONS. A provider webhook has no
 * session at all: the only thing that says which workspace an inbound event
 * belongs to is the endpoint it arrived on — the WhatsApp phone-number id, the
 * Page id — resolved through `ChannelIdentity` by `withChannelTenantScope`.
 *
 * Two probes, both of which failed before this change and neither of which any
 * source-shape test could have caught:
 *
 *  1. THE DEDUPE COLLISION. `BotInboundEvent` deduplicates on
 *     ("tenantId","channel","providerId"). While `withChannelTenantScope` bound
 *     nothing during dormant enforcement, every tenant's events were claimed
 *     under the FOUNDING tenant — so two tenants whose customers produced the
 *     same provider id collided, and the second tenant's genuine message was
 *     read as a redelivery of the first tenant's and acked without ever being
 *     processed. That is a lost customer message with no error anywhere, and it
 *     is the headline defect.
 *
 *  2. THE HALVES MOVING TOGETHER. A staff reply written for workspace B must be
 *     CLAIMED by a reader looking for workspace B, and must be invisible to a
 *     reader looking for workspace A. Converting either half alone produces a
 *     reply that is accepted, reported as sent, and never leaves the queue.
 *
 * EVERY VERIFICATION READS BACK THROUGH `basePrisma` BY KEY. A probe that reads
 * through the boundary it is testing cannot see a wrongly-owned row: the read is
 * narrowed by the same wrong answer the write used, so a stranded row looks
 * exactly like a row that was never written. That mistake has produced false
 * passes here before.
 */
import type { CheckResult } from "./engine";
import type { TenantFixture } from "./seed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = { $queryRawUnsafe: (sql: string, ...v: unknown[]) => Promise<any>; $executeRawUnsafe: (sql: string, ...v: unknown[]) => Promise<any> };

const result = (
  check: CheckResult["check"],
  name: string,
  verdict: CheckResult["verdict"],
  detail: string,
): CheckResult => ({ model: "(bot conversation)", check, name, verdict, detail });

/** Map one of OUR endpoints to a tenant, exactly as the backfill script does. */
async function mapEndpoint(raw: Raw, tenantId: string, channel: string, externalId: string): Promise<void> {
  await raw.$executeRawUnsafe(
    `INSERT INTO "ChannelIdentity" ("id","tenantId","channel","externalId","createdAt")
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)`,
    crypto.randomUUID(),
    tenantId,
    channel,
    externalId,
  );
}

/** Ledger rows for one provider id, by owning tenant. Never through a scoped client. */
async function inboundEventOwners(raw: Raw, providerId: string): Promise<string[]> {
  const rows = (await raw.$queryRawUnsafe(
    `SELECT "tenantId" FROM "BotInboundEvent" WHERE "providerId" = $1 ORDER BY "tenantId"`,
    providerId,
  )) as Array<{ tenantId: string }>;
  return rows.map((row) => row.tenantId);
}

async function outboxRow(
  raw: Raw,
  clientIdempotencyKey: string,
): Promise<{ tenantId: string | null; status: string; attempts: number } | null> {
  const rows = (await raw.$queryRawUnsafe(
    `SELECT "tenantId","status","attempts" FROM "BotFlowOutbox" WHERE "clientIdempotencyKey" = $1`,
    clientIdempotencyKey,
  )) as Array<{ tenantId: string | null; status: string; attempts: number }>;
  return rows[0] ?? null;
}

export async function runBotChannelProbes(
  a: TenantFixture,
  b: TenantFixture,
  raw: Raw,
  enforcing: boolean,
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { withChannelTenantScope } = await import("../../src/lib/tenantScopeEntry");
  const { claimInboundBotEvent } = await import("../../src/lib/botInboundEvent");
  const { enqueueStaffReply, flushBotOutboxConversation } = await import("../../src/lib/botOutbox");
  const { runInTenantScope } = await import("../../src/lib/tenantScope");

  const stamp = Date.now().toString(36);
  const endpointA = `wa-endpoint-a-${stamp}`;
  const endpointB = `wa-endpoint-b-${stamp}`;
  await mapEndpoint(raw, a.tenantId, "whatsapp", endpointA);
  await mapEndpoint(raw, b.tenantId, "whatsapp", endpointB);

  /* ── 1. TWO TENANTS, ONE PROVIDER ID ────────────────────────────────────
   * A provider id is not globally unique: a Telegram `update_id` is per-bot, a
   * Meta mid is per-page. Two customers, on two tenants' endpoints, producing
   * the same id is ordinary — and both of their messages must be processed.
   */
  {
    const shared = `wamid.SHARED-${stamp}`;
    const claimedFor = (endpoint: string): Promise<{ status: string }> =>
      withChannelTenantScope<{ status: string }>(
        "whatsapp",
        endpoint,
        () => claimInboundBotEvent("whatsapp", shared),
        async () => ({ status: "unresolved" }),
      );

    const first = await claimedFor(endpointA);
    const second = await claimedFor(endpointB);
    // basePrisma, by provider id, across every tenant: the only read that can
    // distinguish "B's event was claimed under B" from "B's event collided with
    // A's and was never written at all".
    const owners = await inboundEventOwners(raw, shared);
    const both = owners.includes(a.tenantId) && owners.includes(b.tenantId);
    const bothClaimed = first.status === "claimed" && second.status === "claimed";

    out.push(
      bothClaimed && both
        ? result("UNIQUE", "two tenants sharing a provider id both have their message processed", "pass",
            `both events claimed; ledger rows owned by ${owners.join(" and ")}`)
        : result("UNIQUE", "two tenants sharing a provider id both have their message processed", "fail",
            `MESSAGE LOST: first=${first.status}, second=${second.status}; ledger rows owned by ` +
            `${owners.length ? owners.join(" and ") : "(none)"}. A second-tenant event read as a ` +
            `redelivery of the first tenant's is acked without ever being processed.`),
    );
  }

  /* ── 2. AN UNRESOLVED ENDPOINT MUST NOT NEWLY DROP TRAFFIC ──────────────
   * `ChannelIdentity` is enforcement-prep data no install is required to have
   * backfilled. Failing closed on it while DORMANT would silently drop live
   * customer messages on every unmapped install — which is the defect being
   * fixed, not an acceptable cost of fixing it. Under ENFORCEMENT the opposite
   * is required: an unmapped endpoint must not be processed at all.
   */
  {
    let ran = false;
    const answer = await withChannelTenantScope(
      "whatsapp",
      `never-mapped-${stamp}`,
      async () => {
        ran = true;
        return "processed" as const;
      },
      async () => "skipped" as const,
    );
    const correct = enforcing ? answer === "skipped" && !ran : answer === "processed" && ran;
    out.push(
      correct
        ? result("OWN", "an unmapped endpoint behaves as its mode requires", "pass",
            enforcing ? "enforcing: skipped without running the work" : "dormant: processed unscoped, exactly as before")
        : result("OWN", "an unmapped endpoint behaves as its mode requires", "fail",
            enforcing
              ? `enforcing: an unmapped endpoint was PROCESSED (answer=${answer})`
              : `dormant: an unmapped endpoint was DROPPED (answer=${answer}) — this loses live customer messages`),
    );
  }

  /* ── 3. THE STAFF HALF AND THE READER THAT MUST SEE IT ──────────────────
   * Written for workspace B, claimed by a reader looking for workspace B, and
   * invisible to a reader looking for workspace A. The scope entered here is
   * what `withStaffConversationScope` binds for a real inbox reply.
   */
  {
    const key = `2799900${stamp.slice(-4)}`;
    const idem = `staff-reply-${stamp}`;
    const written = await runInTenantScope({ tenantId: b.tenantId, system: false }, () =>
      enqueueStaffReply({
        channel: "whatsapp",
        key,
        actorId: b.memberUserId,
        parts: [{ message: { type: "text", text: "hello from B" }, clientIdempotencyKey: idem, body: "hello from B" }],
      }),
    );

    const row = await outboxRow(raw, idem);
    const ownedByB = row?.tenantId === b.tenantId;
    out.push(
      written.outcome === "created" && ownedByB
        ? result("OWN", "a staff reply is written for the workspace that is replying", "pass",
            `outbox row owned by ${row?.tenantId}`)
        : result("OWN", "a staff reply is written for the workspace that is replying", "fail",
            `outcome=${written.outcome}, row owner=${row?.tenantId ?? "(no row)"} — expected ${b.tenantId}`),
    );

    // A reader looking for the WRONG workspace must claim nothing. Drained with
    // no provider credentials configured for either tenant, so a claim shows up
    // as an attempt increment rather than a network call.
    const before = await outboxRow(raw, idem);
    await runInTenantScope({ tenantId: a.tenantId, system: false }, () =>
      flushBotOutboxConversation("whatsapp", key, 5),
    );
    const afterWrongReader = await outboxRow(raw, idem);
    out.push(
      afterWrongReader?.attempts === before?.attempts
        ? result("READ", "a reader looking for another workspace does not claim this reply", "pass",
            `attempts unchanged at ${afterWrongReader?.attempts}`)
        : result("READ", "a reader looking for another workspace does not claim this reply", "fail",
            `workspace A's drain claimed workspace B's reply (attempts ${before?.attempts} → ${afterWrongReader?.attempts})`),
    );

    await runInTenantScope({ tenantId: b.tenantId, system: false }, () =>
      flushBotOutboxConversation("whatsapp", key, 5),
    );
    const afterRightReader = await outboxRow(raw, idem);
    const claimed = (afterRightReader?.attempts ?? 0) > (before?.attempts ?? 0);
    out.push(
      claimed
        ? result("READ", "a staff reply written for workspace B is claimed by a reader looking for workspace B", "pass",
            `attempts ${before?.attempts} → ${afterRightReader?.attempts}, status=${afterRightReader?.status}`)
        : result("READ", "a staff reply written for workspace B is claimed by a reader looking for workspace B", "fail",
            `STRANDED: the reply was accepted and no reader will ever claim it ` +
            `(attempts still ${afterRightReader?.attempts}, status=${afterRightReader?.status})`),
    );
  }

  return out;
}
