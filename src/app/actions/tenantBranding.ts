"use server";

import { asActionResult, ActionRefusal, type ActionResult } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import { putManagedBlob } from "@/lib/storage";
import { isBrandColour, normaliseHost } from "@/lib/tenantBrand";
import { domainProof, proofMatches } from "@/lib/domainCheck";
import { safeFetchText } from "@/lib/safeFetch";

/**
 * Branding, set by a PLATFORM ADMIN in the console — the depth and the ownership
 * BRANDING-ROADMAP.md decided: accent colour plus logo, platform admin only, no
 * tenant self-service.
 *
 * Every export here is a public HTTP endpoint reachable by a forged POST, so each
 * one authorises FIRST and validates after. Two of them are more than cosmetic:
 *
 *  - `brandPrimary` is interpolated into a stylesheet. An unvalidated colour
 *    field is a CSS injection vector, so it is checked against `#rrggbb` and
 *    nothing else — here on write, and again in tenantBrand.ts on read.
 *  - A TenantDomain row decides WHOSE BRAND a pre-auth login page renders.
 *    Whoever owns the row owns what is displayed at that address, which makes
 *    hostname assignment an authorization decision even though it only changes
 *    pixels today.
 */

const CONSOLE_PATH = "/platform/tenants";

const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/** Blank clears the field; anything else is stored trimmed and length-capped. */
const optional = (formData: FormData, key: string, max: number): string | null => {
  const raw = value(formData, key);
  return raw ? raw.slice(0, max) : null;
};

async function tenantOrRefuse(tenantId: string) {
  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      brandPrimary: true,
      brandLogoRef: true,
      brandDisplayName: true,
      brandTagline: true,
    },
  });
  if (!tenant) throw new ActionRefusal("Tenant not found.");
  return tenant;
}

/** Accent colour, display name and tagline. The logo has its own action. */
export async function setTenantBrandAction(
  tenantId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const tenant = await tenantOrRefuse(tenantId);

    const rawColour = value(formData, "brandPrimary");
    // Blank means "no accent" — the app's own --primary stands. Anything else
    // must be exactly `#rrggbb`; a near-miss is refused rather than coerced,
    // because coercing untrusted input into a stylesheet is how the injection
    // gets through.
    const brandPrimary = rawColour ? rawColour.toLowerCase() : null;
    if (brandPrimary !== null && !isBrandColour(brandPrimary)) {
      throw new ActionRefusal("Enter the accent colour as a six-digit hex code, e.g. #ea580c.");
    }

    const brandDisplayName = optional(formData, "brandDisplayName", 120);
    const brandTagline = optional(formData, "brandTagline", 160);

    const before = {
      brandPrimary: tenant.brandPrimary,
      brandDisplayName: tenant.brandDisplayName,
      brandTagline: tenant.brandTagline,
    };
    const after = { brandPrimary, brandDisplayName, brandTagline };
    if (
      before.brandPrimary === after.brandPrimary &&
      before.brandDisplayName === after.brandDisplayName &&
      before.brandTagline === after.brandTagline
    ) {
      revalidatePath(CONSOLE_PATH);
      // Claiming "Branding updated" for a no-op would tell an admin they had
      // changed a customer-facing appearance when they had not.
      return { success: "No change — the branding was already set that way" };
    }

    await basePrisma.tenant.update({ where: { id: tenantId }, data: after });
    await logAuditStrict({
      action: "tenant.brand_changed",
      summary: `Updated branding for tenant “${tenant.name}”`,
      entityType: "Tenant",
      entityId: tenantId,
      // Platform admins are not CRM Users — same reasoning as tenants.ts: an id
      // from the wrong identity space dangles in actorUserId.
      userName: actor.name,
      actorType: "platform_admin",
      metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email },
      before,
      after,
    });
    revalidatePath(CONSOLE_PATH);
    return { success: "Branding updated" };
  });
}

/** Logos are small; anything larger is a mistake or an upload probe. */
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/svg+xml", "svg"],
  ["image/webp", "webp"],
]);

export async function setTenantLogoAction(
  tenantId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const tenant = await tenantOrRefuse(tenantId);

    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) throw new ActionRefusal("Choose a logo file.");
    if (file.size > MAX_LOGO_BYTES) throw new ActionRefusal("The logo must be smaller than 1 MB.");
    const ext = LOGO_TYPES.get(file.type);
    // Allow-list, not a deny-list. SVG is included because logos are usually
    // vector — and it is exactly why the file is served from blob storage rather
    // than inlined: an SVG is a document that can carry script, and blob serves
    // it from an origin that is not the app's.
    if (!ext) throw new ActionRefusal("The logo must be a PNG, JPEG, SVG or WebP image.");

    const previous = tenant.brandLogoRef;
    // Timestamp in the path, not a fixed name: putManagedBlob refuses to
    // overwrite (allowOverwrite:false), and a stable name would also be served
    // stale from any CDN in front of it.
    const stamp = Date.now();
    const { pathname } = await putManagedBlob(
      `branding/${tenantId}/logo-${stamp}.${ext}`,
      Buffer.from(await file.arrayBuffer()),
      file.type,
    );

    await basePrisma.tenant.update({ where: { id: tenantId }, data: { brandLogoRef: pathname } });

    // The OLD object is RETAINED, not deleted.
    //
    // A signed document freezes the logo URL it was rendered with, and that URL
    // names this specific object. Deleting it on replacement broke exactly the
    // guarantee freezing exists to provide: a historic contract would either
    // render the new logo or fail to render one at all. Which signed requests
    // reference which asset is not cheap to determine and is easy to get wrong,
    // so nothing is deleted here at all — a retained image costs a few kilobytes
    // and cannot damage a record somebody may have to rely on.
    //
    // Removing genuinely unreferenced branding assets is a retention job with
    // the whole picture, not a side effect of pressing Save.
    await logAuditStrict({
      action: "tenant.brand_logo_changed",
      summary: `Updated logo for tenant “${tenant.name}”`,
      entityType: "Tenant",
      entityId: tenantId,
      userName: actor.name,
      actorType: "platform_admin",
      metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email },
      before: { brandLogoRef: previous },
      after: { brandLogoRef: pathname },
    });
    revalidatePath(CONSOLE_PATH);
    return { success: "Logo updated" };
  });
}

export async function clearTenantLogoAction(
  tenantId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    void formData;
    const actor = await requirePlatformAdminAction();
    const tenant = await tenantOrRefuse(tenantId);
    if (!tenant.brandLogoRef) throw new ActionRefusal("This tenant has no logo to remove.");

    const previous = tenant.brandLogoRef;
    // Detach the pointer; RETAIN the object — the same rule as replacing one.
    //
    // Removing a logo used to delete the underlying asset, which breaks every
    // signed document whose frozen brand names it: the contract renders with a
    // missing image, permanently, because the bytes are gone. Fixing that on the
    // replace path and not this one would have left the identical failure behind
    // a different button.
    //
    // "This tenant has no logo" is a statement about the tenant TODAY. It is not
    // a licence to alter what a document signed last year looks like.
    await basePrisma.tenant.update({ where: { id: tenantId }, data: { brandLogoRef: null } });

    await logAuditStrict({
      action: "tenant.brand_logo_changed",
      summary: `Removed logo for tenant “${tenant.name}”`,
      entityType: "Tenant",
      entityId: tenantId,
      userName: actor.name,
      actorType: "platform_admin",
      metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email },
      before: { brandLogoRef: previous },
      after: { brandLogoRef: null },
    });
    revalidatePath(CONSOLE_PATH);
    return { success: "Logo removed" };
  });
}

/**
 * Fetch https://<hostname>/api/brand/domain-check and require our own proof back.
 *
 * `safeFetchText` rather than bare fetch: the hostname is typed into a form by a
 * platform admin, and without the SSRF guard "verify this domain" is a request
 * the server will make to any address, including the metadata endpoint and
 * anything on the private network. It re-resolves DNS immediately before
 * connecting, so the check cannot be rebound between resolution and request.
 *
 * Every failure is reported as itself. "Could not reach it", "something else is
 * serving it" and "it answered but is not this deployment" are three different
 * problems with three different fixes, and collapsing them into "verification
 * failed" would send someone to check DNS when the domain is simply not attached
 * to the project yet.
 */
async function hostnameServesThisDeployment(
  hostname: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `https://${hostname}/api/brand/domain-check`;
  let body: string;
  try {
    const res = await safeFetchText(url, { timeoutMs: 8000, maxBytes: 4096, accept: "application/json" });
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        error: `${hostname} answered with HTTP ${res.status}. Attach it to the deployment first — DNS alone is not enough.`,
      };
    }
    body = res.text;
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not reach https://${hostname} — ${err instanceof Error ? err.message : "no response"}. ` +
        `Point its DNS at the deployment and add it to the project, then verify.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: `${hostname} is serving something else — it did not answer as this application.` };
  }
  const proof = (parsed as { proof?: unknown } | null)?.proof;
  if (!proofMatches(domainProof(hostname), proof)) {
    return {
      ok: false,
      error: `${hostname} responded, but not as this deployment. Check it is not pointed at a different environment.`,
    };
  }
  return { ok: true };
}

/**
 * Register a hostname for a tenant.
 *
 * ADDED UNVERIFIED. `verifiedAt` stays null until someone proves control, and
 * brandForHost refuses to resolve an unverified row — so adding a hostname here
 * changes nothing that renders. If it resolved on creation, a platform admin
 * could point any domain at any tenant and the platform would serve that brand
 * on an address nobody had proven they own.
 *
 * A hostname already registered to ANOTHER tenant is refused loudly rather than
 * reassigned. Silent reassignment of an ownership mapping is the defect that was
 * found and fixed in the ChannelIdentity backfill; the same rule applies here.
 */
export async function addTenantDomainAction(
  tenantId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const tenant = await tenantOrRefuse(tenantId);

    const hostname = normaliseHost(value(formData, "hostname"));
    if (!hostname) throw new ActionRefusal("Enter a hostname, e.g. crm.acme.co.za.");
    // A hostname, not a URL and not a path. Rejecting these here keeps the
    // stored value in the one shape brandForHost will ever look up.
    if (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes(".")) {
      throw new ActionRefusal("Enter a bare hostname — no protocol, port or path.");
    }

    const existing = await basePrisma.tenantDomain.findUnique({
      where: { hostname },
      select: { id: true, tenantId: true },
    });
    if (existing) {
      throw new ActionRefusal(
        existing.tenantId === tenantId
          ? "That hostname is already registered to this tenant."
          : "That hostname is already registered to another tenant.",
      );
    }

    await basePrisma.tenantDomain.create({ data: { tenantId, hostname } });
    await logAuditStrict({
      action: "tenant.domain_added",
      summary: `Registered ${hostname} for tenant “${tenant.name}” (unverified)`,
      entityType: "Tenant",
      entityId: tenantId,
      userName: actor.name,
      actorType: "platform_admin",
      metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email, hostname },
      after: { hostname, verifiedAt: null },
    });
    revalidatePath(CONSOLE_PATH);
    return { success: `${hostname} added — verify it to start serving this brand` };
  });
}

/**
 * Mark a hostname verified, which is what actually switches branding on for it.
 *
 * Deliberately a separate, explicitly-audited step rather than a checkbox on the
 * add form: this is the moment an address starts rendering someone's brand, and
 * it should read that way in the audit trail.
 *
 * AND IT NOW PROVES THE HOSTNAME REACHES US. This used to write a timestamp on
 * the platform admin's word alone. That was fine while `verifiedAt` only decided
 * whether a login page rendered a logo — if the domain was not wired up, nobody
 * could reach the login page to notice.
 *
 * It is not fine now that outbound links are built from tenant origins
 * (lib/tenantOrigin.ts). A hostname marked verified but not actually attached to
 * the deployment sends every signing link, survey invitation and tracked
 * campaign link for that tenant to an address that does not resolve. The
 * customer gets a dead link; the tenant gets no signature and no reply; nothing
 * errors anywhere. The admin asserting ownership is the right person to ask —
 * they are trusted — but DNS and the Vercel domain attachment are done by
 * someone else in two other systems, and the console cannot see either.
 */
export async function verifyTenantDomainAction(
  tenantId: string,
  domainId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    void formData;
    const actor = await requirePlatformAdminAction();
    const tenant = await tenantOrRefuse(tenantId);

    const domain = await basePrisma.tenantDomain.findUnique({
      where: { id: domainId },
      select: { id: true, tenantId: true, hostname: true, verifiedAt: true },
    });
    // Checked against the tenant in the URL, not just fetched by id — otherwise
    // this verifies another tenant's hostname from a forged POST.
    if (!domain || domain.tenantId !== tenantId) throw new ActionRefusal("Domain not found.");
    if (domain.verifiedAt) throw new ActionRefusal("That hostname is already verified.");

    const reachable = await hostnameServesThisDeployment(domain.hostname);
    if (!reachable.ok) throw new ActionRefusal(reachable.error);

    await basePrisma.tenantDomain.update({
      where: { id: domainId },
      data: { verifiedAt: new Date() },
    });
    await logAuditStrict({
      action: "tenant.domain_verified",
      summary: `Verified ${domain.hostname} for tenant “${tenant.name}”`,
      entityType: "Tenant",
      entityId: tenantId,
      userName: actor.name,
      actorType: "platform_admin",
      metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email, hostname: domain.hostname },
      before: { verifiedAt: null },
      after: { verifiedAt: new Date().toISOString() },
    });
    revalidatePath(CONSOLE_PATH);
    return { success: `${domain.hostname} verified` };
  });
}

export async function removeTenantDomainAction(
  tenantId: string,
  domainId: string,
  formData: FormData,
): Promise<ActionResult> {
  return asActionResult(async () => {
    void formData;
    const actor = await requirePlatformAdminAction();
    const tenant = await tenantOrRefuse(tenantId);

    const domain = await basePrisma.tenantDomain.findUnique({
      where: { id: domainId },
      select: { id: true, tenantId: true, hostname: true },
    });
    if (!domain || domain.tenantId !== tenantId) throw new ActionRefusal("Domain not found.");

    await basePrisma.tenantDomain.delete({ where: { id: domainId } });
    await logAuditStrict({
      action: "tenant.domain_removed",
      summary: `Removed ${domain.hostname} from tenant “${tenant.name}”`,
      entityType: "Tenant",
      entityId: tenantId,
      userName: actor.name,
      actorType: "platform_admin",
      metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email, hostname: domain.hostname },
      before: { hostname: domain.hostname },
    });
    revalidatePath(CONSOLE_PATH);
    return { success: `${domain.hostname} removed` };
  });
}
