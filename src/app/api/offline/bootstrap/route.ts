import { NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import {
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
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
    const [leadIds, contactIds, jobCardIds, quoteIds] = await Promise.all([
      getAccessibleLeadIds(user),
      getAccessibleContactIds(user),
      getAccessibleJobCardIds(user),
      getAccessibleQuoteIds(user),
    ]);

    /*
     * WHAT THIS USER MAY WRITE, shipped with the data.
     *
     * The four id lists above answer "what may they SEE". Every offline form was
     * rendered on the strength of that answer alone, so a role with
     * `leads.view_owned` and no `leads.create` was shown a create form that
     * accepted the work, reported "Saved on this device" and cleared itself --
     * and the replay was refused by `requirePermission` hours later, by which
     * time the typed details existed nowhere.
     *
     * These are exactly the permissions the replayed actions demand, so the
     * device can decline in the one place where the person can still do
     * something about it. The server checks have not moved and are still the
     * boundary; this only stops the UI promising what they will refuse.
     */
    const [leadCreate, leadEdit, contactCreate, contactEdit, jobCardManage, deliveryManage] =
      await Promise.all([
        hasPermission(user, "leads.create"),
        hasPermission(user, "leads.edit"),
        hasPermission(user, "contacts.create"),
        hasPermission(user, "contacts.edit"),
        hasPermission(user, "jobcards.manage"),
        hasPermission(user, "deliveries.manage"),
      ]);
    const [leads, contacts, jobCards, deliveries, stages, products] = await Promise.all([
      prisma.lead.findMany({
        where: { ...(leadIds ? { id: { in: leadIds } } : {}), deletedAt: null },
        select: { id: true, title: true, name: true, email: true, phone: true, status: true, stageId: true, source: true, color: true, notes: true, quantity: true, valueCents: true, productId: true, contactId: true, assignedToId: true, updatedAt: true, stage: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
        take: 500,
      }),
      prisma.contact.findMany({
        where: { ...(contactIds ? { id: { in: contactIds } } : {}), deletedAt: null },
        select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true, whatsapp: true, address: true, suburb: true, city: true, province: true, postalCode: true, source: true, notes: true, marketingOptOut: true, ownerId: true, fleetId: true, isCompany: true, vatNumber: true, updatedAt: true, tags: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
        take: 500,
      }),
      prisma.jobCard.findMany({
        where: { ...(jobCardIds ? { id: { in: jobCardIds } } : {}), deletedAt: null, status: { notIn: ["collected", "cancelled"] } },
        select: {
          id: true, number: true, status: true, description: true, checkinNotes: true, checkoutNotes: true, updatedAt: true,
          contact: { select: { firstName: true, lastName: true, company: true } },
          vehicle: { select: { model: true, regNumber: true } },
          inspectionItems: {
            select: { id: true, label: true, status: true, notes: true, photoStoredName: true },
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 250,
      }),
      prisma.quote.findMany({
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
      prisma.pipelineStage.findMany({
        select: { id: true, name: true },
        orderBy: { order: "asc" },
      }),
      prisma.product.findMany({
        where: { active: true, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const fleetsById = await loadBillToFleets(prisma, deliveries.map((quote) => quote.fleetId));
    const snapshot: OfflineSnapshot = {
      tenantId,
      userId: user.id,
      capturedAt: Date.now(),
      leads: leads.map((lead) => ({ ...lead, stage: lead.stage.name, updatedAt: lead.updatedAt.toISOString() })),
      contacts: contacts.map((contact) => ({
        id: contact.id,
        name: contactName(contact),
        email: contact.email,
        phone: contact.phone,
        whatsapp: contact.whatsapp,
        address: contact.address,
        suburb: contact.suburb,
        city: contact.city,
        province: contact.province,
        postalCode: contact.postalCode,
        source: contact.source,
        notes: contact.notes,
        marketingOptOut: contact.marketingOptOut,
        ownerId: contact.ownerId,
        fleetId: contact.fleetId,
        isCompany: contact.isCompany,
        vatNumber: contact.vatNumber,
        tags: contact.tags.map((tag) => tag.name),
        firstName: contact.firstName,
        lastName: contact.lastName,
        company: contact.company,
        updatedAt: contact.updatedAt.toISOString(),
      })),
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
        })),
      })),
      deliveries: deliveries.map((quote) => ({
        id: quote.id,
        number: quote.number,
        customer: quoteBillTo(quote, fleetsById.get(quote.fleetId ?? "") ?? null).name || "Unlinked customer",
        scheduledFor: quote.deliveryScheduledFor?.toISOString() ?? null,
        updatedAt: quote.updatedAt.toISOString(),
      })),
      can: { leadCreate, leadEdit, contactCreate, contactEdit, jobCardManage, deliveryManage },
      options: { stages, products },
    };
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Offline field data could not be prepared." }, { status: 500 });
  }
}
