import type { ChannelKind } from "./channelTenant";

/**
 * Deciding which inbound endpoints a credential names, and who may claim them.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `ChannelIdentity` answers "which workspace owns this inbound webhook", and
 * under TENANT_ENFORCEMENT=enforce an unanswered question means the event is
 * DISCARDED — `withChannelTenantScope` takes its `onUnresolved` branch, which
 * for WhatsApp and Meta was a bare `console.warn`.
 *
 * Nothing wrote that table except the X integration. So from the enforcement
 * flip (2026-08-12) until 2026-08-30, production accepted WhatsApp credentials,
 * showed a green "Connected" badge, verified them against Meta on demand — and
 * silently threw away every inbound message, DM and lead-gen webhook. Eighteen
 * days, no error row, no symptom anywhere in the product.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * The registered endpoints for a tenant are exactly the ones its CURRENT
 * credentials name. Storing a credential claims what it names; replacing or
 * clearing one retires what it no longer names. Both halves matter — see
 * `retireEndpoints`.
 *
 * ── WHY IT IS A PLAIN MODULE ────────────────────────────────────────────────
 *
 * Free of server/db imports, like tenantCredentialFields.ts, so the decisions
 * below can be RUN in a unit test rather than grepped for. The half that talks
 * to Postgres lives in channelRegistration.ts and injects itself in here.
 */

export type ChannelEndpoint = {
  channel: ChannelKind;
  /** The stable id of OUR endpoint, as the webhook will present it. */
  externalId: string;
  label: string | null;
  /**
   * A label that costs a provider call, resolved ONLY when a row is actually
   * going to be written.
   *
   * This is not a micro-optimisation. `reconcileAllTenantChannels` runs on the
   * automations cron inside a `finally`, after a sweep that may already have
   * spent 45 of the route's 60 seconds. Fetching a cosmetic label per tenant
   * per tick — with a 10s timeout, sequentially — meant two slow tenants could
   * exhaust the route and skip the AI-health check, the backup watchdog and the
   * error-log pruning that follow. A healthy install must do NO provider work.
   */
  resolveLabel?: () => Promise<string | null>;
};

export type RegistrationOutcome =
  | { channel: ChannelKind; externalId: string; status: "registered" | "already_ours" | "reenabled" | "retired" }
  | { channel: ChannelKind; externalId: string; status: "claimed_by_another_tenant"; ownedBy: string };

export type FetchLike = typeof fetch;

const GRAPH = "https://graph.facebook.com/v21.0";
export const GRAPH_TIMEOUT_MS = 10_000;

/**
 * The row store, injected.
 *
 * Same separation as `commitVerifiedCredentials` and `resolveTenantCredential`:
 * the decision — claim it, leave it, retire it, or refuse it — is the part that
 * matters and the part a reviewer needs to be able to check, so it is an
 * ordinary function over an interface rather than something only a live
 * Postgres can exercise.
 */
export type ExistingIdentity = { tenantId: string; disabledAt: Date | null; label: string | null };

export type ChannelIdentityStore = {
  find(channel: ChannelKind, externalId: string): Promise<ExistingIdentity | null>;
  /** This tenant's ACTIVE rows for the given channels. */
  listForTenant(
    tenantId: string,
    channels: readonly ChannelKind[],
  ): Promise<Array<{ channel: ChannelKind; externalId: string }>>;
  create(row: { tenantId: string; channel: ChannelKind; externalId: string; label: string | null }): Promise<void>;
  /**
   * `tenantId` is passed even though `(channel, externalId)` is already unique,
   * so the write can name the tenant it belongs to. That is what keeps the
   * update from being able to edit a row this tenant does not own, and what
   * keeps it off the tenant-access ratchet's bypass list honestly rather than
   * by acknowledgement.
   */
  update(
    channel: ChannelKind,
    externalId: string,
    data: { disabledAt?: null; label?: string },
    tenantId: string,
  ): Promise<void>;
  /** Retire one of this tenant's rows. Never deletes — see `retireEndpoints`. */
  disable(channel: ChannelKind, externalId: string, tenantId: string): Promise<void>;
};

/** Prisma's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/**
 * Register one tenant's endpoints, idempotently.
 *
 * Safe to call on every credential save and on every cron tick: an endpoint
 * already ours and unchanged is not written at all, and no provider call is
 * made for it.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It never takes an endpoint away from another tenant. `@@unique([channel,
 * externalId])` means one endpoint belongs to exactly one workspace, so a
 * second tenant presenting the same phone-number id is either a mistake or an
 * attempt to intercept somebody's messages. Both are refused and reported;
 * neither is served by moving the row.
 */
export async function registerChannelEndpoints(
  tenantId: string,
  endpoints: readonly ChannelEndpoint[],
  deps: { store: ChannelIdentityStore; onConflict?: (outcome: RegistrationOutcome) => void | Promise<void> },
): Promise<RegistrationOutcome[]> {
  const outcomes: RegistrationOutcome[] = [];

  for (const endpoint of endpoints) {
    const externalId = endpoint.externalId.trim();
    if (!externalId) continue;

    const outcome = await registerOne(tenantId, { ...endpoint, externalId }, deps.store);
    outcomes.push(outcome);

    // A contested endpoint is not a routine outcome — it means two workspaces
    // both believe they own one inbound channel, and one of them is receiving
    // nothing. It must be readable rather than inferred from messages failing
    // to arrive.
    if (outcome.status === "claimed_by_another_tenant" && deps.onConflict) {
      await deps.onConflict(outcome);
    }
  }

  return outcomes;
}

async function registerOne(
  tenantId: string,
  endpoint: ChannelEndpoint,
  store: ChannelIdentityStore,
): Promise<RegistrationOutcome> {
  const { channel, externalId } = endpoint;

  const existing = await store.find(channel, externalId);

  if (existing) {
    if (existing.tenantId !== tenantId) {
      return { channel, externalId, status: "claimed_by_another_tenant", ownedBy: existing.tenantId };
    }
    // Ours already. Re-enable it if a previous disconnect disabled it, and fill
    // a label in if it has none — but never churn the row when nothing has
    // changed, and never spend a provider call to discover that nothing has.
    const needsEnable = existing.disabledAt !== null;
    const needsLabel = existing.label === null;
    if (!needsEnable && !needsLabel) return { channel, externalId, status: "already_ours" };

    const label = needsLabel ? await labelFor(endpoint) : null;
    if (!needsEnable && label === null) return { channel, externalId, status: "already_ours" };

    await store.update(
      channel,
      externalId,
      { ...(needsEnable ? { disabledAt: null } : {}), ...(label !== null ? { label } : {}) },
      tenantId,
    );
    return { channel, externalId, status: needsEnable ? "reenabled" : "already_ours" };
  }

  try {
    await store.create({ tenantId, channel, externalId, label: await labelFor(endpoint) });
    return { channel, externalId, status: "registered" };
  } catch (error) {
    // Lost a race with a concurrent save (or the cron sweep). Re-read rather
    // than guess: the winner may have been this same tenant, or another one.
    if (!isUniqueViolation(error)) throw error;
    const winner = await store.find(channel, externalId);
    if (!winner) throw error;
    return winner.tenantId === tenantId
      ? { channel, externalId, status: "already_ours" }
      : { channel, externalId, status: "claimed_by_another_tenant", ownedBy: winner.tenantId };
  }
}

/** A literal label if one was supplied, otherwise the deferred lookup, if any. */
async function labelFor(endpoint: ChannelEndpoint): Promise<string | null> {
  if (endpoint.label !== null) return endpoint.label;
  if (!endpoint.resolveLabel) return null;
  return endpoint.resolveLabel();
}

/**
 * Retire this tenant's rows for `channel` that its credentials no longer name.
 *
 * ── WHY RETIREMENT IS PART OF THE FEATURE ───────────────────────────────────
 *
 * Registering without retiring leaves a workspace holding an endpoint it no
 * longer has credentials for. Two things then go wrong, and the second is worse
 * than the first:
 *
 *   * inbound events for the old endpoint keep resolving into the old
 *     workspace, so a number that was disconnected still files messages there;
 *   * NO OTHER WORKSPACE CAN EVER CLAIM IT, because the unique row still
 *     belongs to the former tenant — so a number transferred between tenants is
 *     permanently stuck, and `registerChannelEndpoints` correctly refuses to
 *     steal it back.
 *
 * That is precisely the shape of the bug this whole module exists to fix, just
 * arrived at from the other direction.
 *
 * ── AUTHORITY IS REQUIRED ───────────────────────────────────────────────────
 *
 * `keepIds` must be the COMPLETE set of endpoints the credentials name for this
 * channel, and the caller must know that for certain. A Graph call that failed
 * returns no endpoints, and treating that as "the tenant has none" would retire
 * every working row on a transient Meta outage. So `reconcileTenantChannels`
 * retires Meta channels only when discovery actually succeeded — see
 * `MetaDiscovery`.
 *
 * Disabled, never deleted: `disabledAt` keeps the audit trail and the history
 * of which workspace an endpoint used to belong to.
 */
export async function retireEndpoints(
  tenantId: string,
  channel: ChannelKind,
  keepIds: readonly string[],
  deps: { store: ChannelIdentityStore },
): Promise<RegistrationOutcome[]> {
  const keep = new Set(keepIds.map((id) => id.trim()).filter(Boolean));
  const active = await deps.store.listForTenant(tenantId, [channel]);
  const outcomes: RegistrationOutcome[] = [];

  for (const row of active) {
    if (keep.has(row.externalId)) continue;
    await deps.store.disable(row.channel, row.externalId, tenantId);
    outcomes.push({ channel: row.channel, externalId: row.externalId, status: "retired" });
  }

  return outcomes;
}

/**
 * The WhatsApp endpoint a credential bundle names.
 *
 * No provider call: `WA_PHONE_NUMBER_ID` IS the discriminator the webhook
 * presents in `value.metadata.phone_number_id`. That matters — it means a
 * WhatsApp connection registers correctly even when Graph is unreachable at the
 * moment the owner clicks Save.
 */
export function whatsappEndpointFrom(phoneNumberId: string | null | undefined): ChannelEndpoint | null {
  const externalId = (phoneNumberId ?? "").trim();
  if (!externalId) return null;
  return { channel: "whatsapp", externalId, label: null };
}

/** Best-effort human label for a WhatsApp number. Never blocks registration. */
export async function whatsappLabelFrom(
  phoneNumberId: string,
  accessToken: string | null,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const res = await fetchImpl(`${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { display_phone_number?: string; verified_name?: string };
    const parts = [body.verified_name, body.display_phone_number].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}

/**
 * Whether Meta actually answered.
 *
 * `ok: false` is NOT "this tenant has no Pages" — it is "we do not know". The
 * difference decides whether retirement may run, so the two can never be
 * collapsed into an empty array.
 */
export type MetaDiscovery = { ok: true; endpoints: ChannelEndpoint[] } | { ok: false };

/**
 * The Messenger and Instagram endpoints a Meta page token can reach.
 *
 * These DO need a provider call: the webhook presents the Page id and the
 * Instagram professional-account id, and neither is stored anywhere — the
 * tenant only ever supplies a token. `me/accounts` is the same call the Meta
 * lead sync already makes.
 *
 * Never throws. A save must not fail because Graph was slow; the cron sweep
 * retries a tenant whose rows are still missing.
 */
export async function metaEndpointsFrom(
  pageAccessToken: string | null | undefined,
  deps: { fetch?: FetchLike } = {},
): Promise<MetaDiscovery> {
  const token = (pageAccessToken ?? "").trim();
  // No token is an ANSWER: this tenant has no Meta credentials, so it should
  // hold no Meta endpoints. That is authoritative, and retirement may act on it.
  if (!token) return { ok: true, endpoints: [] };
  const fetchImpl = deps.fetch ?? fetch;

  try {
    const res = await fetchImpl(`${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as {
      data?: Array<{ id?: string; name?: string; instagram_business_account?: { id?: string; username?: string } }>;
    };

    const endpoints: ChannelEndpoint[] = [];
    for (const page of body.data ?? []) {
      if (page.id) {
        endpoints.push({ channel: "messenger", externalId: String(page.id), label: page.name ?? null });
      }
      const ig = page.instagram_business_account;
      if (ig?.id) {
        endpoints.push({
          channel: "instagram",
          externalId: String(ig.id),
          label: ig.username ? `@${ig.username}` : null,
        });
      }
    }
    return { ok: true, endpoints };
  } catch {
    return { ok: false };
  }
}

/**
 * Which credential keys, when written OR CLEARED, change the set of inbound
 * endpoints a tenant owns.
 *
 * `WA_ACCESS_TOKEN` is here because clearing it disconnects WhatsApp even
 * though the phone-number id remains; the reconcile that follows re-derives the
 * whole set either way.
 */
export const CHANNEL_BEARING_KEYS: ReadonlySet<string> = new Set([
  "WA_PHONE_NUMBER_ID",
  "WA_ACCESS_TOKEN",
  "META_PAGE_ACCESS_TOKEN",
]);

export function keyNamesAnInboundEndpoint(key: string): boolean {
  return CHANNEL_BEARING_KEYS.has(key.trim());
}
