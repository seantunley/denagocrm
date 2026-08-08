import "server-only";
import { getPortalContact } from "./portal";
import { customerBrand, type LoginBrand } from "./loginBrand";

/**
 * The brand for a portal page — contact's tenant first, hostname as the
 * fallback.
 *
 * The portal LAYOUT already resolves this for its header, and every page below
 * it needs the same answer for its copy ("the Denago team", "Your Denago
 * garage"). Rather than passing it down — a layout cannot hand props to a page —
 * each page calls this, and it costs nothing extra: `getPortalContact`,
 * `brandForTenant` and `brandForHost` are all `cache()`d per request, so the
 * layout and every page in one render share a single resolution.
 *
 * Never throws, for the same reason nothing else on a customer-facing path does:
 * a decorative name must not be able to take down a page a customer is using.
 */
export async function portalBrand(): Promise<LoginBrand> {
  const contact = await getPortalContact().catch(() => null);
  return customerBrand(contact?.tenantId ?? null);
}
