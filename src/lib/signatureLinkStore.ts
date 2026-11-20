import "server-only";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { isModuleEnabled } from "./modules/enabled";
import { anonymousClickDay, CLICK_MAX_ANONYMOUS_PER_DAY } from "./signatureBanners";
import { rewriteSignatureLinks, signatureLinkKind, signatureLinkUrls, SIGNATURE_LINK_KINDS, type SignatureLinkKind } from "./signatureLinks";

/*
 * The store behind counted signature links (lib/signatureLinks.ts, item 11): one row per person per address, made the
 * first time it is sent, with the count on the row. Every query names the workspace.
 */

/** A second fetch of a link within this long is the same click (mail scanners often fetch a link twice). */
export const LINK_CLICK_DEDUPE_SECONDS = 30;

/**
 * The signature HTML with its web links counted, for a send. Any failure leaves the links as they were: an email is
 * never lost or delayed over a count.
 */
export async function trackSignatureLinks(
  args: {
    tenantId: string | null;
    userId: string;
    origin: string;
    /** The owner's "Count clicks on signature links" rule. */
    on: boolean | undefined;
    known: { website?: string; bookingUrl?: string | null; privacyUrl?: string };
  },
  signatureHtml: string,
): Promise<string> {
  const { tenantId, userId, origin, known } = args;
  if (!tenantId || !args.on) return signatureHtml;
  try {
    // Part of the Email signatures pack: off, every link goes out exactly as written.
    if (!(await isModuleEnabled("signatures"))) return signatureHtml;
    const urls = signatureLinkUrls(signatureHtml).filter((url) => url.length <= 500).slice(0, 20);
    if (!urls.length) return signatureHtml;
    const existing = await prisma.signatureLink.findMany({ where: { tenantId, userId, url: { in: urls } }, select: { url: true, token: true } });
    const tokens = new Map(existing.map((row) => [row.url, row.token]));
    for (const url of urls.filter((u) => !tokens.has(u))) {
      const row = await prisma.signatureLink.upsert({
        where: { tenantId_userId_url: { tenantId, userId, url } },
        update: {},
        create: { tenantId, userId, url, kind: signatureLinkKind(url, known), token: randomBytes(18).toString("base64url") },
        select: { token: true },
      });
      tokens.set(url, row.token);
    }
    const base = origin.replace(/\/$/, "");
    return rewriteSignatureLinks(signatureHtml, (url) => (tokens.has(url) ? `${base}/api/track/s/${tokens.get(url)}` : undefined));
  } catch {
    return signatureHtml;
  }
}

/** Where a counted link goes. Null for an unknown token, or an address that is no longer a plain https link. */
export async function resolveSignatureLink(token: string): Promise<{ id: string; tenantId: string; url: string } | null> {
  const link = await prisma.signatureLink.findUnique({ where: { token }, select: { id: true, tenantId: true, url: true } });
  return link && /^https:\/\/[^\s"'<>]+$/i.test(link.url) ? link : null;
}

/** Count a click, bounded: once per link per LINK_CLICK_DEDUPE_SECONDS, and at most the banners' daily cap per link. */
export async function recordSignatureLinkClick(link: { id: string; tenantId: string }): Promise<void> {
  const { id, tenantId } = link;
  const now = new Date();
  const day = anonymousClickDay(now);
  // Decided by the database, one statement per gate, so two fetches arriving together can't both count.
  const fresh = await prisma.signatureLink.updateMany({
    where: { id, tenantId, OR: [{ lastClickAt: null }, { lastClickAt: { lt: new Date(now.getTime() - LINK_CLICK_DEDUPE_SECONDS * 1000) } }] },
    data: { lastClickAt: now },
  });
  if (fresh.count !== 1) return;
  const firstToday = await prisma.signatureLink.updateMany({
    where: { id, tenantId, OR: [{ clickDay: null }, { clickDay: { not: day } }] },
    data: { clickDay: day, dayClicks: 1, clickCount: { increment: 1 } },
  });
  if (firstToday.count === 1) return;
  await prisma.signatureLink.updateMany({
    where: { id, tenantId, clickDay: day, dayClicks: { lt: CLICK_MAX_ANONYMOUS_PER_DAY } },
    data: { dayClicks: { increment: 1 }, clickCount: { increment: 1 } },
  });
}

/** The owner's report: clicks by kind, and by person, for this workspace. */
export async function signatureLinkReport(tenantId: string): Promise<{
  byKind: { kind: SignatureLinkKind; clicks: number }[];
  byPerson: Record<string, number>;
  total: number;
}> {
  const rows = await prisma.signatureLink.findMany({ where: { tenantId }, select: { userId: true, kind: true, clickCount: true } });
  const byKind = SIGNATURE_LINK_KINDS.map((kind) => ({ kind, clicks: rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.clickCount, 0) }));
  const byPerson: Record<string, number> = {};
  for (const row of rows) byPerson[row.userId] = (byPerson[row.userId] ?? 0) + row.clickCount;
  return { byKind, byPerson, total: rows.reduce((n, r) => n + r.clickCount, 0) };
}
