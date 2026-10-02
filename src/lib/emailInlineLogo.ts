import { basePrisma } from "./db";
import { decryptValue } from "./settings";
import { readManagedBlob } from "./storage";
import { brandLogoAsset } from "./tenantBrand";

/**
 * Put the workspace's logo INSIDE the email instead of linking to it.
 *
 * A linked logo is a remote image, and most mail clients block remote images
 * until the reader clicks "show images" — so the first thing a customer saw of
 * a quote, a signing request or a campaign was a broken-image box where the
 * logo should be. An inline (CID) attachment is part of the message and shows
 * straight away.
 *
 * Only THIS workspace's own logo is embedded: its public brand-logo route
 * (bytes read straight from storage, nothing fetched over the network), or —
 * exactly — the Company Profile logo URL configured for it. Any other image,
 * including the open-tracking pixel, is left as it was, and any failure leaves
 * the plain link: an email is never lost to its logo.
 */

export type InlineImage = { filename: string; content: Buffer; contentType: string; cid: string };
export type LoadedImage = { content: Buffer; contentType: string };
export type ImageLoader = (src: string) => Promise<LoadedImage | null>;

const EXT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
const TYPE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif" };
const MAX_LOGO_BYTES = 1024 * 1024;
const CACHE_MS = 10 * 60 * 1000;

/**
 * Swap every <img src> the loader can supply for a cid: reference, returning
 * the attachments to send with it. Pure apart from the loader, so it is tested
 * without storage or network (tests/emailInlineLogo.test.ts).
 */
export async function inlineImages(html: string, load: ImageLoader): Promise<{ html: string; attachments: InlineImage[] }> {
  const raws = [...new Set([...html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/gi)].map((match) => match[1]))];
  const attachments: InlineImage[] = [];
  let out = html;
  for (const raw of raws) {
    // Attribute values arrive HTML-escaped (escapeHtml turns & into &amp;).
    const src = raw.replace(/&amp;/g, "&");
    if (!/^https:\/\//i.test(src)) continue;
    const image = await load(src).catch(() => null);
    if (!image) continue;
    const n = attachments.length + 1;
    const cid = `logo${n}@inline`;
    attachments.push({ filename: `logo${n}.${TYPE_EXT[image.contentType] ?? "png"}`, content: image.content, contentType: image.contentType, cid });
    out = out.split(`src="${raw}"`).join(`src="cid:${cid}"`);
  }
  return { html: out, attachments };
}

// A campaign sends the same logo to every recipient: read it once, not per mail.
// ponytail: per-process cache, 10 minutes — a logo replaced mid-campaign shows
// from the next process or the next ten minutes.
const cache = new Map<string, { at: number; image: LoadedImage | null }>();

/** The loader for one workspace: its brand-logo route, or its exact Company Profile logo URL. */
export function workspaceLogoLoader(tenantId: string): ImageLoader {
  return async (src) => {
    const key = `${tenantId} ${src}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.image;
    const image = await loadWorkspaceLogo(tenantId, src).catch(() => null);
    cache.set(key, { at: Date.now(), image });
    return image;
  };
}

async function loadWorkspaceLogo(tenantId: string, src: string): Promise<LoadedImage | null> {
  const url = new URL(src);
  // 1. This workspace's public brand-logo route. The same object the route would
  //    stream, rebuilt the same way (tenant folder + strictly matched asset name),
  //    read from storage — the URL's host is never contacted.
  if (url.pathname === `/api/brand/logo/${tenantId}`) {
    const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { active: true, brandLogoRef: true } });
    if (!tenant?.active) return null;
    const asset = brandLogoAsset(url.searchParams.get("a") || tenant.brandLogoRef);
    const contentType = asset ? EXT_TYPES[asset.split(".").pop()!.toLowerCase()] : undefined;
    if (!asset || !contentType) return null;
    const content = await readManagedBlob(`branding/${tenantId}/${asset}`);
    return content.length <= MAX_LOGO_BYTES ? { content, contentType } : null;
  }
  // 2. The Company Profile logo — only the exact public https URL this workspace
  //    configured, so a template cannot point the server at anything else.
  const row = await basePrisma.appSetting.findUnique({
    where: { tenantId_key: { tenantId, key: "COMPANY_LOGO_URL" } },
    select: { value: true },
  });
  const configured = row?.value ? decryptValue(row.value).trim() : "";
  if (!configured || configured !== src || /\.private\.blob\.|\/api\/stored/i.test(configured)) return null;
  const response = await fetch(src, { signal: AbortSignal.timeout(5000), redirect: "error" });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || !contentType.startsWith("image/")) return null;
  const content = Buffer.from(await response.arrayBuffer());
  return content.length <= MAX_LOGO_BYTES ? { content, contentType } : null;
}
