/**
 * WHAT THIS SOFTWARE CALLS ITSELF WHEN IT CANNOT NAME A TENANT.
 *
 * Every brand fallback in the app used to be the string "Denago Cape Town". That
 * was correct while there was one customer, and it is a white-label leak now: an
 * unrecognised hostname, a customer whose tenant could not be resolved, or a
 * database blip during login would show ONE customer's trading name to ANOTHER
 * customer's visitors. The failure mode of a branding system must be anonymity,
 * not somebody else's brand.
 *
 * So the fallbacks now resolve here, and Denago gets its name the same way every
 * other tenant does — from its own Tenant row and its own Company Profile, seeded
 * by 20260806190000_seed_founding_tenant_brand. Nothing about what Denago sees
 * changes; what changes is WHY they see it.
 *
 * ── Client-safe, deliberately ───────────────────────────────────────────────
 *
 * companyBrand.ts is imported by the document-editor canvas, which runs in the
 * browser, so the name has to survive the client bundle. Hence NEXT_PUBLIC_.
 * There is nothing secret here — it is the name on a login page.
 *
 * ── Why "CRM" and not a product name ────────────────────────────────────────
 *
 * Because this software does not have one yet, and inventing one in a fallback
 * constant is how a placeholder ends up on a customer's screen. Set
 * NEXT_PUBLIC_PLATFORM_NAME when it does; nothing else needs to change.
 */
export const PLATFORM_NAME = process.env.NEXT_PUBLIC_PLATFORM_NAME?.trim() || "CRM";

/**
 * How an unbranded email signs off.
 *
 * NOT `The ${PLATFORM_NAME} team` — a recipient reading "The CRM team" learns
 * that the sender could not work out who it was, which is worse than a sign-off
 * that simply does not name anyone. Every branded path passes a real name.
 */
export const PLATFORM_TEAM_SIGNOFF = "The team";
