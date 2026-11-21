import "server-only";
import { prisma } from "../../db";
import { contactName } from "../../format";
import { johannesburgDateKey } from "../../activityDay";
import { isModuleEnabled } from "../../modules/enabled";
import { getAccessibleVehicleIds, hasAnyPermission } from "../../permissions";
import { WARRANTY_READ } from "../../warrantyAccess";
import { computeWarranty, warrantyLabels } from "../../warranty";
import { termLabel, vehicleCover } from "../../warrantyParts";
import { CERTIFICATE_TAG } from "../../warrantyCertificate";
import { currentOwnersCertificate } from "../../assistantWarrantyCertificateRules";
import { type ToolOutput, type User, fuzzy, refused } from "../lookupKit";

const day = (d: Date | null | undefined) => (d ? johannesburgDateKey(d) : null);

/**
 * DAX knows the warranties (Sean, 2026-11-21: "check warranties on vehicles and know which vehicle belongs to which
 * customer … and which vehicle has been purchased … retrieve the warranty information and send the warranty certificate
 * to chat when requested"). Who owns what, what they bought, each part's cover, and the certificate's link — which is
 * delivered to the person asking, never to the customer (assistantWarrantyCertificate.ts).
 *
 * The Warranty module on, the warranty grant AND vehicle access, as the vehicle page; only vehicles they may open.
 */
export async function vehicleWarranty(user: User, args: { search?: string; limit?: number }): Promise<ToolOutput> {
  if (!(await isModuleEnabled("warranty"))) return { truncated: false, rows: [], data: [{ note: "Warranty isn't switched on for this workspace." }] };
  if (!(await hasAnyPermission(user, ...WARRANTY_READ))) return refused("warranties");
  if (!(await hasAnyPermission(user, "vehicles.view_all", "vehicles.view_owned"))) return refused("customer vehicles");
  const accessible = await getAccessibleVehicleIds(user);
  const take = args.limit ?? 10;
  const words = (args.search ?? "").split(/\s+/).filter((w) => w.length >= 2).slice(0, 6);
  const matches = (w: string) => ({
    OR: [
      { model: fuzzy(w) }, { regNumber: fuzzy(w) }, { vin: fuzzy(w) }, { product: { name: fuzzy(w) } },
      { contact: { OR: [{ firstName: fuzzy(w) }, { lastName: fuzzy(w) }, { company: fuzzy(w) }] } },
    ],
  });
  const found = await prisma.vehicle.findMany({
    where: { deletedAt: null, ...(accessible ? { id: { in: accessible } } : {}), ...(words.length ? { AND: words.map(matches) } : {}) },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    select: {
      id: true, model: true, vin: true, regNumber: true, color: true, contactId: true,
      purchaseDate: true, warrantyMonths: true, warrantyParts: true, warrantyStartsAt: true,
      product: { select: { name: true } },
      contact: { select: { firstName: true, lastName: true, company: true, isCompany: true } },
      documents: { where: { tag: CERTIFICATE_TAG, deletedAt: null, replacedById: null }, orderBy: { createdAt: "desc" }, take: 1, select: { id: true, createdAt: true, contactId: true } },
    },
  });
  const page = found.slice(0, take);
  const now = new Date();
  return {
    truncated: found.length > take,
    data: page.map((v) => {
      const overall = computeWarranty(v, now);
      // A previous owner's certificate is never offered as this owner's.
      const certificate = currentOwnersCertificate(v.documents, v.contactId);
      return {
        vehicle: v.model, link: `/vehicles/${v.id}`, vin: v.vin, reg: v.regNumber, colour: v.color,
        owner: contactName(v.contact), ownerLink: `/contacts/${v.contactId}`, product: v.product?.name ?? null,
        delivered: day(v.warrantyStartsAt ?? v.purchaseDate),
        warranty: warrantyLabels[overall.status],
        cover: vehicleCover(v, now).map((c) => ({ part: c.part, cover: termLabel(c.months), until: day(c.until), status: c.status })),
        certificate: certificate
          ? { link: `/api/files/${certificate.id}`, issued: day(certificate.createdAt) }
          : v.documents.length > 0
            ? "only a previous owner's is filed — a new one must be issued for the current owner"
            : "none filed yet",
      };
    }),
    rows: page.map((v) => ({ label: `${v.model} — ${contactName(v.contact)}`, detail: v.regNumber ?? v.vin ?? "no reg", href: `/vehicles/${v.id}` })),
  };
}
