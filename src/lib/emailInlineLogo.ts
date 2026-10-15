import { basePrisma } from "./db";
import { decryptValue } from "./settings";
import { readManagedBlob } from "./storage";
import { brandLogoAsset } from "./tenantBrand";
import { signatureAsset } from "./signatureAssets";
import { parseSignatureDesign, SIGNATURE_DESIGN_KEY } from "./signature";

/**
 * Put the workspace's logo INSIDE the email instead of linking to it.
 *
 * A linked logo is a remote image, and most mail clients block remote images
 * until the reader clicks "show images" — so the first thing a customer saw of
 * a quote, a signing request or a campaign was a broken-image box where the
 * logo should be. An inline (CID) attachment is part of the message and shows
 * straight away.
 *
 * Also embedded: the card signature's five fixed images (signatureAssets.ts).
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
/** The largest image embedded in an email. An upload meant for email (the signature banner) is capped at this too. */
export const MAX_LOGO_BYTES = 1024 * 1024;
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
    // A SCREENSHOT PASTED INTO THE MESSAGE (Sean, 2026-10-15: "I must be able to
    // paste in image screenshots, like Outlook"). It arrives as a data: URI, which
    // most mail clients will not show — Gmail strips them — so it goes the way the
    // logo does: inside the message, as an inline attachment.
    const pasted = pastedImage(src);
    if (pasted) {
      const n = attachments.length + 1;
      const cid = `image${n}@inline`;
      attachments.push({ filename: `image${n}.${TYPE_EXT[pasted.contentType] ?? "png"}`, content: pasted.content, contentType: pasted.contentType, cid });
      out = out.split(`src="${raw}"`).join(`src="cid:${cid}"`);
      continue;
    }
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

/** The largest image pasted into a message that is embedded. The composer shrinks a screenshot well below this first. */
export const MAX_PASTED_IMAGE_BYTES = 3 * 1024 * 1024;
const PASTED = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i;

/** A pasted image's bytes, or null for anything else — another type (no SVG: it can carry script), too big, or not base64. */
export function pastedImage(src: string): LoadedImage | null {
  const match = PASTED.exec(src);
  if (!match) return null;
  const content = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (content.length === 0 || content.length > MAX_PASTED_IMAGE_BYTES) return null;
  return { content, contentType: match[1].toLowerCase() };
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
  // 0. The card signature's own five images (signatureAssets.ts): bytes compiled
  //    into the app, matched by exact name — nothing is fetched or read from disk.
  const signature = signatureAsset(url.pathname);
  if (signature) return { content: signature, contentType: "image/png" };
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
  // 2. The Company Profile logo or the signature's logo-panel banner — only the
  //    exact public https URLs this workspace configured, so a template cannot
  //    point the server at anything else.
  const rows = await basePrisma.appSetting.findMany({
    where: { tenantId, key: { in: ["COMPANY_LOGO_URL", SIGNATURE_DESIGN_KEY] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => {
    const raw = rows.find((row) => row.key === key)?.value;
    return raw ? decryptValue(raw).trim() : "";
  };
  const configured = [value("COMPANY_LOGO_URL"), parseSignatureDesign(value(SIGNATURE_DESIGN_KEY)).bannerUrl];
  // …or one of this workspace's signature banners (lib/signatureBanners.ts),
  // matched on the exact stored address for the same reason.
  if (!configured.includes(src) && (await basePrisma.signatureBanner.findFirst({ where: { tenantId, imageUrl: src }, select: { id: true } }))) {
    configured.push(src);
  }
  if (!configured.includes(src) || /\.private\.blob\.|\/api\/stored/i.test(src)) return null;
  const response = await fetch(src, { signal: AbortSignal.timeout(5000), redirect: "error" });
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!response.ok || !contentType.startsWith("image/") || !response.body) return null;
  // The cap is enforced WHILE reading (review of #744): a declared length over it
  // is refused before any body is read, and an undeclared or lying one is cut off
  // at the cap — never buffered whole first.
  if (Number(response.headers.get("content-length") ?? 0) > MAX_LOGO_BYTES) {
    await response.body.cancel().catch(() => {});
    return null;
  }
  const content = await readCapped(response.body, MAX_LOGO_BYTES);
  return content ? { content, contentType } : null;
}

/** Read a stream into memory, giving up (and cancelling it) once it passes `max` bytes. */
export async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
