import "server-only";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { resolveTenantCredential } from "./settings";
import type { ChannelKind } from "./channelTenant";
import {
  metaEndpointsFrom,
  registerChannelEndpoints,
  retireEndpoints,
  whatsappEndpointFrom,
  whatsappLabelFrom,
  type ChannelEndpoint,
  type ChannelIdentityStore,
  type FetchLike,
  type RegistrationOutcome,
} from "./channelEndpoints";

/**
 * The database half of inbound-channel registration.
 *
 * The decisions — claim an endpoint, leave it, retire it, or refuse it — live
 * in channelEndpoints.ts, which is a plain module so they can be unit-tested.
 * This file supplies the store, reads the stored credentials, and provides the
 * entry points the rest of the app calls: one per credential change, one for
 * the cron sweep that repairs installs predating either.
 */

export { keyNamesAnInboundEndpoint } from "./channelEndpoints";
export type { ChannelEndpoint, RegistrationOutcome } from "./channelEndpoints";

const META_CHANNELS: readonly ChannelKind[] = ["messenger", "instagram"];

/**
 * `basePrisma`, and every write names its tenant.
 *
 * The lookup is deliberately unscoped — "who owns this endpoint" is a question
 * asked ACROSS tenants, and answering it only within the caller's own tenant
 * would report an endpoint another workspace holds as free, which is the one
 * mistake this module must never make.
 *
 * The writes are the opposite: they target `(tenantId, channel, externalId)`
 * through `updateMany`, not the `(channel, externalId)` unique key alone. If
 * ownership has changed underneath us the write matches nothing instead of
 * editing a row that is no longer ours.
 */
const store: ChannelIdentityStore = {
  find: (channel, externalId) =>
    basePrisma.channelIdentity.findUnique({
      where: { channel_externalId: { channel, externalId } },
      select: { tenantId: true, disabledAt: true, label: true },
    }),
  listForTenant: async (tenantId, channels) => {
    const rows = await basePrisma.channelIdentity.findMany({
      where: { tenantId, channel: { in: [...channels] }, disabledAt: null },
      select: { channel: true, externalId: true },
    });
    return rows.map((row) => ({ channel: row.channel as ChannelKind, externalId: row.externalId }));
  },
  create: async (row) => {
    await basePrisma.channelIdentity.create({
      data: { tenantId: row.tenantId, channel: row.channel, externalId: row.externalId, label: row.label },
    });
  },
  update: async (channel, externalId, data, tenantId) => {
    await basePrisma.channelIdentity.updateMany({ where: { tenantId, channel, externalId }, data });
  },
  disable: async (channel, externalId, tenantId) => {
    await basePrisma.channelIdentity.updateMany({
      where: { tenantId, channel, externalId, disabledAt: null },
      data: { disabledAt: new Date() },
    });
  },
};

/**
 * Bring one tenant's `ChannelIdentity` rows into line with its stored
 * credentials — claiming what they name, and retiring what they no longer do.
 *
 * Called after every credential change, and by the cron sweep.
 *
 * ── THE HEALTHY PATH DOES NO NETWORK WORK ───────────────────────────────────
 *
 * WhatsApp needs no provider call to identify its endpoint, and its cosmetic
 * label is resolved lazily — only when a row is actually being written. Meta
 * discovery is skipped when the tenant already has rows for BOTH Meta channels.
 * So a fully-registered tenant costs a handful of indexed reads per tick and
 * nothing else, which is what makes it safe to run inside the automations
 * route's leftover budget.
 *
 * NEVER THROWS. Registration is a consequence of saving a credential, not a
 * condition of it: an owner whose token is fine must not see their save fail
 * because Meta was briefly unreachable.
 */
export async function reconcileTenantChannels(
  tenantId: string,
  opts: { force?: boolean; fetch?: FetchLike; allowDiscovery?: boolean } = {},
): Promise<RegistrationOutcome[]> {
  try {
    const fetchImpl = opts.fetch ?? fetch;
    const outcomes: RegistrationOutcome[] = [];
    const endpoints: ChannelEndpoint[] = [];

    // ── WhatsApp ────────────────────────────────────────────────────────────
    const phoneNumberId = await resolveTenantCredential(tenantId, "WA_PHONE_NUMBER_ID");
    const accessToken = await resolveTenantCredential(tenantId, "WA_ACCESS_TOKEN");
    // Both halves are required for the channel to work at all, so clearing
    // either one disconnects it — and a disconnected channel must not keep
    // holding the endpoint against a workspace that may want to claim it.
    const whatsapp = accessToken ? whatsappEndpointFrom(phoneNumberId) : null;
    if (whatsapp) {
      endpoints.push({
        ...whatsapp,
        resolveLabel: () => whatsappLabelFrom(whatsapp.externalId, accessToken, fetchImpl),
      });
    }
    // Authoritative either way: the credential itself says what WhatsApp
    // endpoint this tenant has, with no provider involved.
    outcomes.push(
      ...(await retireEndpoints(tenantId, "whatsapp", whatsapp ? [whatsapp.externalId] : [], { store })),
    );

    // ── Messenger + Instagram ───────────────────────────────────────────────
    //
    // Checked per channel, not as a pair: a tenant whose backfill registered
    // only the Page, or who linked an Instagram account after the Page row was
    // created, would otherwise never discover the second endpoint and its
    // inbound events would be discarded indefinitely.
    const discoveryAllowed = opts.force || (opts.allowDiscovery ?? true);
    const needsMeta = opts.force || (await missingMetaChannels(tenantId)).length > 0;
    if (needsMeta && discoveryAllowed) {
      const pageToken = await resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN");
      const discovery = await metaEndpointsFrom(pageToken, { fetch: fetchImpl });
      if (discovery.ok) {
        endpoints.push(...discovery.endpoints);
        // Only when Meta actually answered. A failed call returns no endpoints,
        // and treating that as "the tenant has none" would retire every working
        // row on a transient outage.
        for (const channel of META_CHANNELS) {
          const keep = discovery.endpoints.filter((e) => e.channel === channel).map((e) => e.externalId);
          outcomes.push(...(await retireEndpoints(tenantId, channel, keep, { store })));
        }
      }
    }

    if (endpoints.length > 0) {
      outcomes.push(
        ...(await registerChannelEndpoints(tenantId, endpoints, {
          store,
          onConflict: async (outcome) => {
            await logError(
              "channel-registration",
              `${outcome.channel} endpoint ${outcome.externalId} is already registered to another workspace, so it ` +
                `was NOT re-pointed. Inbound ${outcome.channel} events for it continue to reach the workspace that ` +
                `holds it.`,
              undefined,
              { tenantId },
            ).catch(() => {});
          },
        })),
      );
    }

    return outcomes;
  } catch (error) {
    await logError("channel-registration", error, `tenant ${tenantId}`, { tenantId }).catch(() => {});
    return [];
  }
}

/** Which Meta channels this tenant has no active row for. */
async function missingMetaChannels(tenantId: string): Promise<ChannelKind[]> {
  const rows = await store.listForTenant(tenantId, META_CHANNELS);
  const present = new Set(rows.map((row) => row.channel));
  return META_CHANNELS.filter((channel) => !present.has(channel));
}

/**
 * The backstop: reconcile every active tenant.
 *
 * This is what covers the installs that already exist. A tenant configured
 * before this shipped has credentials and no rows, and nobody is going to
 * re-save a working integration to trigger the write — so the repair cannot
 * depend on the owner doing anything.
 *
 * ── IT IS BOUNDED, BECAUSE ITS CALLER IS NOT ────────────────────────────────
 *
 * The automations route runs this in a `finally`, after a sweep that may have
 * spent 45 of its 60 seconds. Meta discovery is the only part that can block on
 * a slow provider, so it is limited two ways: a wall-clock deadline that stops
 * the sweep cleanly, and a cap on how many tenants may perform discovery in one
 * tick. Tenants beyond the cap are simply repaired on a later tick — the sweep
 * runs every fifteen minutes and is idempotent — and the maintenance that
 * follows this call is never starved.
 *
 * Must be called inside a system scope (the cron does): it reads credentials
 * across tenants, and `resolveTenantCredential` falls back to the founding
 * tenant's `AppSetting` for the founding tenant only.
 */
export async function reconcileAllTenantChannels(
  opts: { deadlineMs?: number; maxDiscoveries?: number } = {},
): Promise<{ tenants: number; registered: number; retired: number; conflicts: number; skipped: number }> {
  const deadline = Date.now() + (opts.deadlineMs ?? 8_000);
  let discoveriesLeft = opts.maxDiscoveries ?? 3;

  const tenants = await basePrisma.tenant.findMany({ where: { active: true }, select: { id: true } });
  let registered = 0;
  let retired = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    if (Date.now() >= deadline) {
      skipped += 1;
      continue;
    }
    // Ask before spending the budget: a tenant that needs no discovery is a
    // few indexed reads and cannot block, so it always runs.
    const wantsDiscovery = (await missingMetaChannels(tenant.id).catch(() => [])).length > 0;
    if (wantsDiscovery && discoveriesLeft <= 0) {
      skipped += 1;
      continue;
    }
    if (wantsDiscovery) discoveriesLeft -= 1;

    const outcomes = await reconcileTenantChannels(tenant.id, { allowDiscovery: wantsDiscovery });
    for (const outcome of outcomes) {
      if (outcome.status === "registered" || outcome.status === "reenabled") registered += 1;
      if (outcome.status === "retired") retired += 1;
      if (outcome.status === "claimed_by_another_tenant") conflicts += 1;
    }
  }

  return { tenants: tenants.length, registered, retired, conflicts, skipped };
}

/**
 * An inbound event arrived for an endpoint no workspace claims, so it was
 * discarded. SAY SO.
 *
 * This is the most important line in the feature. The registration above stops
 * the fault happening; this is what makes it survivable if it ever happens
 * again. The previous behaviour was `console.warn`, which on Vercel means a
 * line in a log nobody reads — so eighteen days of dropped customer messages
 * produced no error row, no notification, and nothing on any screen in the
 * product. The System Log is where an owner and a platform admin can both see
 * it.
 *
 * Never throws, and never changes the response: acknowledging is still the
 * right answer to an event we cannot attribute — asking Meta to redeliver
 * something no tenant owns would only retry until Meta gives up, and the
 * message is lost either way. What changes is that somebody is told.
 */
export async function reportUnmappedEndpoint(
  channel: ChannelKind,
  externalId: string | null | undefined,
  droppedCount: number,
): Promise<void> {
  await logError(
    `${channel}-webhook`,
    `Inbound ${channel} event discarded: endpoint ${externalId ?? "(none supplied)"} is not registered to any ` +
      `workspace, so there is no tenant to file it against. ${droppedCount} message(s) lost. Connect or re-test ` +
      `this channel in Settings → Integrations to register it.`,
  ).catch(() => {});
}
