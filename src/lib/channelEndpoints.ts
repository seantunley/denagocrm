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
 * It hid because Facebook and Instagram LEADS kept arriving throughout: those
 * come from `syncFacebookLeads` polling Meta on the automations cron, which
 * never touches the webhook. The one path still working was the loudest one.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A credential that names an inbound endpoint MUST register that endpoint. Not
 * as a step an owner performs, and not as a migration that fixes today's
 * tenants and forgets tomorrow's — as a consequence of storing the credential.
 *
 * ── WHY IT IS A PLAIN MODULE ────────────────────────────────────────────────
 *
 * Free of server/db imports, like tenantCredentialFields.ts, so the decision
 * below can be RUN in a unit test rather than grepped for. The half that talks
 * to Postgres lives in channelRegistration.ts and injects itself in here.
 */

export type ChannelEndpoint = {
  channel: ChannelKind;
  /** The stable id of OUR endpoint, as the webhook will present it. */
  externalId: string;
  label: string | null;
};

export type RegistrationOutcome =
  | { channel: ChannelKind; externalId: string; status: "registered" | "already_ours" | "reenabled" }
  | { channel: ChannelKind; externalId: string; status: "claimed_by_another_tenant"; ownedBy: string };

export type FetchLike = typeof fetch;

const GRAPH = "https://graph.facebook.com/v21.0";
export const GRAPH_TIMEOUT_MS = 10_000;

/**
 * The row store, injected.
 *
 * Same separation as `commitVerifiedCredentials` and `resolveTenantCredential`:
 * the decision — claim it, leave it, or refuse it — is the part that matters
 * and the part a reviewer needs to be able to check, so it is an ordinary
 * function over an interface rather than something only a live Postgres can
 * exercise. `tests/channelRegistration.test.ts` drives every branch, including
 * the two that are hard to reach on purpose: an endpoint another tenant already
 * holds, and losing the create race.
 */
export type ExistingIdentity = { tenantId: string; disabledAt: Date | null; label: string | null };

export type ChannelIdentityStore = {
  find(channel: ChannelKind, externalId: string): Promise<ExistingIdentity | null>;
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
};

/** Prisma's unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/**
 * Register one tenant's endpoints, idempotently.
 *
 * Safe to call on every credential save and on every cron tick: an endpoint
 * already ours and unchanged is not written at all, so the sweep is a read.
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
  const { channel, externalId, label } = endpoint;

  const existing = await store.find(channel, externalId);

  if (existing) {
    if (existing.tenantId !== tenantId) {
      return { channel, externalId, status: "claimed_by_another_tenant", ownedBy: existing.tenantId };
    }
    // Ours already. Re-enable it if a previous disconnect disabled it, and
    // freshen a label that has since been discovered — but never churn the row
    // when nothing has changed, so the cron sweep stays a pure read.
    const needsEnable = existing.disabledAt !== null;
    const needsLabel = label !== null && label !== existing.label;
    if (!needsEnable && !needsLabel) return { channel, externalId, status: "already_ours" };

    await store.update(
      channel,
      externalId,
      { ...(needsEnable ? { disabledAt: null } : {}), ...(needsLabel ? { label } : {}) },
      tenantId,
    );
    return { channel, externalId, status: needsEnable ? "reenabled" : "already_ours" };
  }

  try {
    await store.create({ tenantId, channel, externalId, label });
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
 * The Messenger and Instagram endpoints a Meta page token can reach.
 *
 * These DO need a provider call: the webhook presents the Page id and the
 * Instagram professional-account id, and neither is stored anywhere — the
 * tenant only ever supplies a token. `me/accounts` is the same call the Meta
 * lead sync already makes.
 *
 * Returns [] on any failure rather than throwing. A save must not fail because
 * Graph was slow; the cron sweep retries a tenant whose rows are still missing.
 */
export async function metaEndpointsFrom(
  pageAccessToken: string | null | undefined,
  deps: { fetch?: FetchLike } = {},
): Promise<ChannelEndpoint[]> {
  const token = (pageAccessToken ?? "").trim();
  if (!token) return [];
  const fetchImpl = deps.fetch ?? fetch;

  try {
    const res = await fetchImpl(`${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
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
    return endpoints;
  } catch {
    return [];
  }
}

/**
 * Which credential keys, when written, name an inbound endpoint.
 *
 * Used by the settings write paths to decide whether a save needs to reconcile.
 * `WA_ACCESS_TOKEN` is here for its label only; the phone-number id is what
 * actually identifies the endpoint.
 */
export const CHANNEL_BEARING_KEYS: ReadonlySet<string> = new Set([
  "WA_PHONE_NUMBER_ID",
  "WA_ACCESS_TOKEN",
  "META_PAGE_ACCESS_TOKEN",
]);

export function keyNamesAnInboundEndpoint(key: string): boolean {
  return CHANNEL_BEARING_KEYS.has(key.trim());
}
