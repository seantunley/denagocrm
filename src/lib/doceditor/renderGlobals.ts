import "server-only";
import fs from "fs";
import path from "path";
import { getCurrentUser } from "@/lib/auth";
import { documentGlobalTokens } from "@/lib/docbuilder/merge";
import { isStoredFileRef, readManagedBlob } from "@/lib/storage";
import { embedStoredImage } from "@/lib/storedImage";
import { brandForTenant, brandLogoAsset } from "@/lib/tenantBrand";
import { currentTenantScope } from "@/lib/tenantScope";
import type { DocumentModel } from "./model";

/**
 * What a doc-editor render needs resolved server-side before the (pure,
 * synchronous) serializer runs: the workspace's logo and any uploaded images,
 * as embedded `data:` URLs, and the {{user.name}} / {{date.today}} tokens.
 *
 * Embedded rather than linked because the stored files are private (no public
 * URL) and because the PDF renderer and the customer's signing page have no
 * session to fetch them with.
 */

const DEFAULT_LOGO = path.join(process.cwd(), "public", "branding", "denago-logo-email.png");
let defaultLogoCache: string | null | undefined;

/** The built-in logo, embedded — used when a workspace has none of its own. */
export function defaultLogoDataUri(): string | undefined {
  if (defaultLogoCache !== undefined) return defaultLogoCache ?? undefined;
  try {
    defaultLogoCache = `data:image/png;base64,${fs.readFileSync(DEFAULT_LOGO).toString("base64")}`;
  } catch {
    defaultLogoCache = null;
  }
  return defaultLogoCache ?? undefined;
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",
};
const BRAND_LOGO_PATH = /^\/api\/brand\/logo\/([A-Za-z0-9_-]+)$/;
const PUBLIC_BRANDING = /^\/branding\/([A-Za-z0-9._-]+\.(?:png|jpe?g|webp))$/i;

function dataUri(bytes: Buffer, fileName: string): string {
  const type = IMAGE_TYPES[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png";
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/**
 * A workspace logo URL — the Company Profile's `logoUrl` or a frozen brand's —
 * as something a printed document can embed.
 *
 * The shapes that URL takes, and what each becomes:
 *  - the tenant brand route `/api/brand/logo/<tenant>?a=<asset>` (absolute, from
 *    getCompanyProfile) → that exact asset's bytes, so a frozen logo stays frozen;
 *  - a `/branding/<file>` asset of this app (the seeded Denago profile points at
 *    one on crm.denagocpt.co.za) → the file from `public/`;
 *  - one of our stored files → read with the owner check, like a template logo;
 *  - an outside https link → passed through untouched, as it always was. It is
 *    NOT fetched here: fetching a URL a tenant admin typed is an SSRF lever.
 * Anything else, or anything unreadable, falls back to the built-in logo.
 */
export async function documentLogo(logoUrl: string | null | undefined, tenantId?: string | null): Promise<string | undefined> {
  const url = logoUrl?.trim();
  if (!url) return defaultLogoDataUri();
  if (/^data:image\//i.test(url)) return url;
  try {
    if (isStoredFileRef(url)) {
      return (await embedStoredImage(url, tenantId ?? currentTenantScope()?.tenantId ?? null)) ?? defaultLogoDataUri();
    }
    const parsed = new URL(url, "https://relative.invalid");
    const brand = BRAND_LOGO_PATH.exec(parsed.pathname);
    if (brand) {
      // Tenant id and asset name are both strictly matched, so the path is
      // rebuilt exactly as the public logo route rebuilds it.
      const asset = brandLogoAsset(parsed.searchParams.get("a") || (await brandForTenant(brand[1])).logoRef);
      return asset ? dataUri(await readManagedBlob(`branding/${brand[1]}/${asset}`), asset) : defaultLogoDataUri();
    }
    const file = PUBLIC_BRANDING.exec(parsed.pathname);
    if (file) return dataUri(await fs.promises.readFile(path.join(process.cwd(), "public", "branding", file[1])), file[1]);
  } catch {
    return defaultLogoDataUri();
  }
  return /^https:\/\//i.test(url) ? url : defaultLogoDataUri();
}

/** {{user.name}} / {{date.today}} for a live render; blank user when nobody on staff is signed in. */
export async function liveGlobalTokens(): Promise<Record<string, string>> {
  const user = await getCurrentUser().catch(() => null);
  return documentGlobalTokens(user?.name);
}

/**
 * The document with every uploaded image block's stored ref replaced by the
 * embedded image. The owner check is against `tenantId` — the template's or the
 * signature request's workspace — so a ref pasted in from another workspace is
 * refused, and its image dropped rather than linked. Undefined means the acting
 * workspace.
 */
export async function embedDocImages(doc: DocumentModel, tenantId?: string | null): Promise<DocumentModel> {
  const owner = tenantId === undefined ? currentTenantScope()?.tenantId ?? null : tenantId;
  const walk = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (!value || typeof value !== "object") return value;
    const node = value as Record<string, unknown>;
    if (node.type === "image" && typeof node.src === "string" && isStoredFileRef(node.src.trim())) {
      return { ...node, src: (await embedStoredImage(node.src.trim(), owner)) ?? "" };
    }
    const entries = await Promise.all(Object.entries(node).map(async ([k, v]) => [k, await walk(v)] as const));
    return Object.fromEntries(entries);
  };
  return (await walk(doc)) as DocumentModel;
}
