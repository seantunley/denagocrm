import { NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { prisma } from "@/lib/db";
import {
  getAccessibleContactIds,
  getAccessibleJobCardIds,
  getAccessibleLeadIds,
  getAccessibleQuoteIds,
} from "@/lib/permissions";
import { contactName } from "@/lib/format";
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
    const [leads, contacts, jobCards, deliveries, stages, products] = await Promise.all([
      prisma.lead.findMany({
        where: { ...(leadIds ? { id: { in: leadIds } } : {}), deletedAt: null },
        select: { id: true, title: true, name: true, email: true, phone: true, status: true, updatedAt: true, stage: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
        take: 500,
      }),
      prisma.contact.findMany({
        where: { ...(contactIds ? { id: { in: contactIds } } : {}), deletedAt: null },
        select: { id: true, firstName: true, lastName: true, company: true, email: true, phone: true, whatsapp: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: 500,
      }),
      prisma.jobCard.findMany({
        where: { ...(jobCardIds ? { id: { in: jobCardIds } } : {}), deletedAt: null, status: { notIn: ["collected", "cancelled"] } },
        select: {
          id: true, number: true, status: true, description: true, checkinNotes: true, checkoutNotes: true, updatedAt: true,
          contact: { select: { firstName: true, lastName: true, company: true } },
          vehicle: { select: { model: true, registration: true } },
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
        updatedAt: contact.updatedAt.toISOString(),
      })),
      jobCards: jobCards.map((job) => ({
        id: job.id,
        number: job.number,
        status: job.status,
        description: job.description,
        customer: contactName(job.contact),
        vehicle: [job.vehicle.model, job.vehicle.registration].filter(Boolean).join(" · "),
        checkinNotes: job.checkinNotes,
        checkoutNotes: job.checkoutNotes,
        updatedAt: job.updatedAt.toISOString(),
      })),
      deliveries: deliveries.map((quote) => ({
        id: quote.id,
        number: quote.number,
        customer: quote.contact ? contactName(quote.contact) : "Unlinked customer",
        scheduledFor: quote.deliveryScheduledFor?.toISOString() ?? null,
        updatedAt: quote.updatedAt.toISOString(),
      })),
      options: { stages, products },
    };
    return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Offline field data could not be prepared." }, { status: 500 });
  }
}
