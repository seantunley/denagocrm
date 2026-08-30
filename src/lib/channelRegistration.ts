import "server-only";
import { basePrisma } from "./db";
import { logError } from "./errorLog";
import { resolveTenantCredential } from "./settings";
import type { ChannelKind } from "./channelTenant";
import {
  metaEndpointsFrom,
  registerChannelEndpoints,
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
 * The decision — claim an endpoint, leave it, or refuse it — lives in
 * channelEndpoints.ts, which is a plain module so it can be unit-tested. This
 * file supplies the store, reads the stored credentials, and provides the two
 * entry points the rest of the app calls: one per credential save, one for the
 * cron sweep that repairs installs predating either.
 */

export { keyNamesAnInboundEndpoint } from "./channelEndpoints";
export type { ChannelEndpoint, RegistrationOutcome } from "./channelEndpoints";

/**
 * `basePrisma`, and every call names its tenant.
 *
 * The lookup is deliberately unscoped — "who owns this endpoint" is a question
 * asked ACROSS tenants, and answering it only within the caller's own tenant
 * would report an endpoint another workspace holds as free, which is the one
 * mistake this module must never make.
 *
 * The writes are the opposite. `update` targets `(tenantId, channel,
 * externalId)` through `updateMany`, not the `(channel, externalId)` unique key
 * alone: ownership was checked a moment earlier by `registerOne`, and naming
 * the tenant here means a re-check it cannot skip. If ownership has changed
 * underneath us the update matches nothing instead of editing a row that is no
 * longer ours.
 */
const store: ChannelIdentityStore = {
  find: (channel, externalId) =>
    basePrisma.channelIdentity.findUnique({
      where: { channel_externalId: { channel, externalId } },
      select: { tenantId: true, disabledAt: true, label: true },
    }),
  create: async (row) => {
    await basePrisma.channelIdentity.create({
      data: { tenantId: row.tenantId, channel: row.channel, externalId: row.externalId, label: row.label },
    });
  },
  update: async (channel, externalId, data, tenantId) => {
    await basePrisma.channelIdentity.updateMany({
      where: { tenantId, channel, externalId },
      data,
    });
  },
};

/**
 * Bring one tenant's `ChannelIdentity` rows into line with its stored
 * credentials.
 *
 * Called after every credential write, and by the cron sweep. Cheap by
 * construction: WhatsApp needs no provider call at all, and the Meta lookup is
 * skipped entirely once the tenant already has its rows — so a healthy install
 * costs one indexed read per tenant per tick, not a Graph round trip.
 *
 * NEVER THROWS. Registration is a consequence of saving a credential, not a
 * condition of it: an owner whose token is fine must not see their save fail
 * because Meta was briefly unreachable.
 */
export async function reconcileTenantChannels(
  tenantId: string,
  opts: { force?: boolean; fetch?: FetchLike } = {},
): Promise<RegistrationOutcome[]> {
  try {
    const fetchImpl = opts.fetch ?? fetch;
    const endpoints: ChannelEndpoint[] = [];

    const phoneNumberId = await resolveTenantCredential(tenantId, "WA_PHONE_NUMBER_ID");
    const whatsapp = whatsappEndpointFrom(phoneNumberId);
    if (whatsapp) {
      const accessToken = await resolveTenantCredential(tenantId, "WA_ACCESS_TOKEN");
      endpoints.push({
        ...whatsapp,
        label: await whatsappLabelFrom(whatsapp.externalId, accessToken, fetchImpl),
      });
    }

    // The Meta half is the expensive one, so ask whether it is needed first.
    // `force` is for the credential-save path, where the token may have changed
    // to one naming a different Page and the stale row must not be trusted.
    const needsMeta = opts.force || !(await hasMetaRows(tenantId));
    if (needsMeta) {
      const pageToken = await resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN");
      endpoints.push(...(await metaEndpointsFrom(pageToken, { fetch: fetchImpl })));
    }

    if (endpoints.length === 0) return [];

    return await registerChannelEndpoints(tenantId, endpoints, {
      store,
      onConflict: async (outcome) => {
        await logError(
          "channel-registration",
          `${outcome.channel} endpoint ${outcome.externalId} is already registered to another workspace, so it was NOT ` +
            `re-pointed. Inbound ${outcome.channel} events for it continue to reach the workspace that holds it.`,
          undefined,
          { tenantId },
        ).catch(() => {});
      },
    });
  } catch (error) {
    await logError("channel-registration", error, `tenant ${tenantId}`, { tenantId }).catch(() => {});
    return [];
  }
}

async function hasMetaRows(tenantId: string): Promise<boolean> {
  const found = await basePrisma.channelIdentity.findFirst({
    where: { tenantId, channel: { in: ["messenger", "instagram"] }, disabledAt: null },
    select: { id: true },
  });
  return found !== null;
}

/**
 * The backstop: reconcile every active tenant.
 *
 * This is what covers the installs that already exist. A tenant configured
 * before this shipped has credentials and no rows, and nobody is going to
 * re-save a working integration to trigger the write — so the repair cannot
 * depend on the owner doing anything.
 *
 * Must be called inside a system scope (the cron does): it reads credentials
 * across tenants, and `resolveTenantCredential` falls back to the founding
 * tenant's `AppSetting` for the founding tenant only.
 */
export async function reconcileAllTenantChannels(): Promise<{
  tenants: number;
  registered: number;
  conflicts: number;
}> {
  const tenants = await basePrisma.tenant.findMany({ where: { active: true }, select: { id: true } });
  let registered = 0;
  let conflicts = 0;

  for (const tenant of tenants) {
    const outcomes = await reconcileTenantChannels(tenant.id);
    for (const outcome of outcomes) {
      if (outcome.status === "registered" || outcome.status === "reenabled") registered += 1;
      if (outcome.status === "claimed_by_another_tenant") conflicts += 1;
    }
  }

  return { tenants: tenants.length, registered, conflicts };
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
