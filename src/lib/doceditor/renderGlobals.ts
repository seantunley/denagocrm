import "server-only";
import fs from "fs";
import path from "path";
import { getActiveTenantId, getCurrentUser } from "@/lib/auth";
import { documentGlobalTokens } from "@/lib/docbuilder/merge";
import { isStoredFileRef, readManagedBlob } from "@/lib/storage";
import { embedStoredImage } from "@/lib/storedImage";
import { brandForTenant, brandLogoAsset, brandLogoUrl } from "@/lib/tenantBrand";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { currentTenantScope } from "@/lib/tenantScope";
import { getRegionalSettings } from "@/lib/settings";
import type { Regional } from "@/lib/format";
import { classifyLogoUrl } from "./logoSource";
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
function dataUri(bytes: Buffer, fileName: string): string {
  const type = IMAGE_TYPES[fileName.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png";
  return `data:${type};base64,${bytes.toString("base64")}`;
}

async function actingTenant(tenantId?: string | null): Promise<string | null> {
  if (tenantId) return tenantId;
  return currentTenantScope()?.tenantId ?? (await getActiveTenantId().catch(() => null));
}

/** The tenant's UPLOADED brand logo as an immutable-asset path, or null when it has none. */
async function tenantBrandLogoPath(tenantId: string | null): Promise<string | null> {
  return tenantId ? brandLogoUrl(await brandForTenant(tenantId)) : null;
}

/**
 * A workspace logo URL — the Company Profile's `logoUrl` or a frozen brand's —
 * embedded for a document. It NEVER returns a link to an outside host: see
 * logoSource.ts for each shape. An outside link is replaced by the tenant's
 * uploaded brand logo; anything unreadable, by the built-in logo.
 */
export async function documentLogo(logoUrl: string | null | undefined, tenantId?: string | null): Promise<string | undefined> {
  const url = logoUrl?.trim() ?? "";
  const source = classifyLogoUrl(url);
  try {
    switch (source.kind) {
      case "none":
        return defaultLogoDataUri();
      case "data":
        return url;
      case "stored":
        return (await embedStoredImage(url, await actingTenant(tenantId))) ?? defaultLogoDataUri();
      case "brand": {
        // Tenant id and asset name are both strictly matched, so the path is
        // rebuilt exactly as the public logo route rebuilds it.
        const asset = brandLogoAsset(source.asset || (await brandForTenant(source.tenantId)).logoRef);
        return asset ? dataUri(await readManagedBlob(`branding/${source.tenantId}/${asset}`), asset) : defaultLogoDataUri();
      }
      case "public":
        return dataUri(await fs.promises.readFile(path.join(process.cwd(), "public", "branding", source.file)), source.file);
      case "external": {
        const brand = await tenantBrandLogoPath(await actingTenant(tenantId));
        return brand ? documentLogo(brand) : defaultLogoDataUri();
      }
    }
  } catch {
    return defaultLogoDataUri();
  }
}

/**
 * The logo URL to FREEZE on a signature request, at send time. An outside link
 * is swapped for the tenant's uploaded brand logo (an immutable-asset URL, so
 * it stays frozen) or null — the built-in logo — rather than frozen as a link
 * whose image its host can change or remove after the customer has signed.
 */
export async function freezableLogoUrl(logoUrl: string | null, tenantId?: string | null): Promise<string | null> {
  if (classifyLogoUrl(logoUrl).kind !== "external") return logoUrl;
  const owner = await actingTenant(tenantId);
  const brand = await tenantBrandLogoPath(owner);
  return brand ? `${await tenantOrigin(owner)}${brand}` : null;
}

/** {{user.name}} / {{date.today}} for a live render; blank user when nobody on staff is signed in. */
export async function liveGlobalTokens(regional?: Regional): Promise<Record<string, string>> {
  const user = await getCurrentUser().catch(() => null);
  return documentGlobalTokens(user?.name, new Date(), regional ?? (await getRegionalSettings()));
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
