import { NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/enabled";
import {
  getAccessibleJobCardIds,
  getAccessibleQuoteIds,
  hasPermission,
} from "@/lib/permissions";
import { contactName } from "@/lib/format";
import { loadBillToFleets, quoteBillTo } from "@/lib/quoteBillTo";
import type { OfflineSnapshot } from "@/lib/offlineTypes";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireApiUser();
    const tenantId = await actingTenantId();
    const [jobCardIds, quoteIds] = await Promise.all([
      getAccessibleJobCardIds(user),
      getAccessibleQuoteIds(user),
    ]);

    /*
     * WHAT THIS USER MAY WRITE, shipped with the data.
     *
     * The id lists above answer "what may they SEE", which is a different
     * question. Rendering a capture form on the strength of that alone meant a
     * role without the write permission was told the work was saved on the
     * device and had the replay refuse it hours later.
     *
     * A permission is also not an entitlement: job cards and deliveries belong
     * to the automotive pack and every one of their actions calls
     * requireModuleEnabled first. Both layers, or neither.
     */
    const [jobCardPermitted, deliveryPermitted, automotive] = await Promise.all([
      hasPermission(user, "jobcards.manage"),
      hasPermission(user, "deliveries.manage"),
      isModuleEnabled("automotive"),
    ]);

    const jobCardManage = jobCardPermitted && automotive;
    const deliveryManage = deliveryPermitted && automotive;
    const [jobCards, deliveries] = await Promise.all([
      // Not merely ungated but ABSENT when the pack is off: a device should not
      // be carrying records from a module this workspace does not have.
      !automotive ? [] : prisma.jobCard.findMany({
        where: { ...(jobCardIds ? { id: { in: jobCardIds } } : {}), deletedAt: null, status: { notIn: ["collected", "cancelled"] } },
        select: {
          id: true, number: true, status: true, description: true, checkinNotes: true, checkoutNotes: true, updatedAt: true,
          contact: { select: { firstName: true, lastName: true, company: true } },
          vehicle: { select: { model: true, regNumber: true } },
          inspectionItems: {
            select: { id: true, label: true, status: true, notes: true, photoStoredName: true, updatedAt: true },
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 250,
      }),
      !automotive ? [] : prisma.quote.findMany({
        where: {
          ...(quoteIds ? { id: { in: quoteIds } } : {}),
          deletedAt: null,
          signedAt: { not: null },
          deliveredAt: null,
        },
        select: {
          id: true, number: true, deliveryScheduledFor: true, updatedAt: true,
          fleetId: true,
          contact: { select: { firstName: true, lastName: true, company: true } },
        },
        orderBy: { deliveryScheduledFor: "asc" },
        take: 250,
      }),
    ]);

    const fleetsById = await loadBillToFleets(prisma, deliveries.map((quote) => quote.fleetId));

    const snapshot: OfflineSnapshot = {
      tenantId,
      userId: user.id,
      capturedAt: Date.now(),
      jobCards: jobCards.map((job) => ({
        id: job.id,
        number: job.number,
        status: job.status,
        description: job.description,
        customer: contactName(job.contact),
        vehicle: [job.vehicle.model, job.vehicle.regNumber].filter(Boolean).join(" · "),
        checkinNotes: job.checkinNotes,
        checkoutNotes: job.checkoutNotes,
        updatedAt: job.updatedAt.toISOString(),
        inspectionItems: job.inspectionItems.map((item) => ({
          id: item.id,
          label: item.label,
          status: item.status,
          notes: item.notes,
          hasPhoto: Boolean(item.photoStoredName),
          updatedAt: item.updatedAt.toISOString(),
        })),
      })),
      deliveries: deliveries.map((quote) => ({
        id: quote.id,
        number: quote.number,
        customer: quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name || "Unlinked customer",
        scheduledFor: quote.deliveryScheduledFor?.toISOString() ?? null,
        updatedAt: quote.updatedAt.toISOString(),
      })),
      can: { jobCardManage: jobCardPermitted && automotive, deliveryManage: deliveryPermitted && automotive },
    };
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Offline field data could not be prepared." }, { status: 500 });
  }
}
