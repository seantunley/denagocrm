import "server-only";
import { resolveTenantCredential } from "./settings";
import type { ChannelEndpoint } from "./channelEndpoints";

/**
 * WHICH FACEBOOK PAGE THIS WORKSPACE'S META FEATURES USE (Connect Facebook, Sean 2026-11-21: "Build this and lets test
 * it" — the CRM's own Meta app, each business connecting its own Page from Settings).
 *
 * - `connected`: the business pressed Connect Facebook and chose its Page (lib/metaConnect.ts). The Page's own token,
 *   its id, its linked Instagram account and the permissions granted are stored for THIS workspace only. Wins.
 * - `system-user`: the pasted System User token (META_PAGE_ACCESS_TOKEN) — the way every workspace was set up before,
 *   still Denago's until it connects. Its Page is found by exchanging it (me/accounts), as before.
 *
 * Every reader of the Meta token goes through here — sending, channel registration, lead ads, the lead webhook and
 * the permission check — so a connected Page is used everywhere at once.
 */
export const CONNECTED = {
  pageToken: "META_CONNECTED_PAGE_TOKEN",
  pageId: "META_CONNECTED_PAGE_ID",
  pageName: "META_CONNECTED_PAGE_NAME",
  igId: "META_CONNECTED_IG_ID",
  igUsername: "META_CONNECTED_IG_USERNAME",
  scopes: "META_CONNECTED_SCOPES",
  byUser: "META_CONNECTED_BY_USER",
  at: "META_CONNECTED_AT",
} as const;

export type MetaPageCredential =
  | { kind: "connected"; pageId: string; pageToken: string; pageName: string | null; igId: string | null; igUsername: string | null; scopes: string[] }
  | { kind: "system-user"; userToken: string };

export async function metaPageCredential(tenantId: string | null): Promise<MetaPageCredential | null> {
  if (tenantId) {
    const [pageToken, pageId] = await Promise.all([
      resolveTenantCredential(tenantId, CONNECTED.pageToken),
      resolveTenantCredential(tenantId, CONNECTED.pageId),
    ]);
    if (pageToken && pageId) {
      const [pageName, igId, igUsername, scopes] = await Promise.all([
        resolveTenantCredential(tenantId, CONNECTED.pageName),
        resolveTenantCredential(tenantId, CONNECTED.igId),
        resolveTenantCredential(tenantId, CONNECTED.igUsername),
        resolveTenantCredential(tenantId, CONNECTED.scopes),
      ]);
      return { kind: "connected", pageId, pageToken, pageName, igId, igUsername, scopes: (scopes ?? "").split(",").filter(Boolean) };
    }
  }
  const userToken = await resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN");
  return userToken ? { kind: "system-user", userToken } : null;
}

/** The endpoints a connected Page names: the Page (Messenger) and its linked Instagram account, when there is one. */
export function connectedMetaEndpoints(credential: Extract<MetaPageCredential, { kind: "connected" }>): ChannelEndpoint[] {
  return [
    { channel: "messenger", externalId: credential.pageId, label: credential.pageName },
    ...(credential.igId ? [{ channel: "instagram" as const, externalId: credential.igId, label: credential.igUsername ? `@${credential.igUsername}` : null }] : []),
  ];
}

/** A token that can read this workspace's lead ads: the connected Page's, or the System User token as before. */
export function metaLeadToken(credential: MetaPageCredential | null): string | null {
  if (!credential) return null;
  return credential.kind === "connected" ? credential.pageToken : credential.userToken;
}
