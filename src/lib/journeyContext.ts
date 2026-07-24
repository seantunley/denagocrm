import { prisma } from "./db";
import { contactName } from "./format";

export type JourneyEntityType = "lead" | "contact" | "system";

export type JourneyContext = Record<string, unknown> & {
  event: Record<string, unknown>;
  source: Record<string, unknown>;
  lead: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactContact(contact: {
  id: string;
  firstName: string;
  lastName: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  source: string | null;
  province: string | null;
  marketingOptOut: boolean;
  ownerId: string | null;
  tags: Array<{ id: string; name: string }>;
  vehicles: Array<{ id: string; model: string; purchaseDate: Date | null }>;
}) {
  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: contactName(contact),
    company: contact.company,
    email: contact.email,
    phone: contact.phone,
    whatsapp: contact.whatsapp,
    source: contact.source,
    province: contact.province,
    marketingOptOut: contact.marketingOptOut,
    ownerId: contact.ownerId,
    tags: contact.tags.map((tag) => tag.id),
    tagNames: contact.tags.map((tag) => tag.name),
    hasVehicle: contact.vehicles.length > 0,
    vehicles: contact.vehicles.map((vehicle) => ({
      id: vehicle.id,
      model: vehicle.model,
      purchaseDate: vehicle.purchaseDate?.toISOString() ?? null,
    })),
  };
}

function compactLead(lead: {
  id: string;
  title: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: string;
  valueCents: number;
  quantity: number;
  stageId: string;
  productId: string | null;
  assignedToId: string | null;
  contactId: string | null;
  updatedAt: Date;
  stage: { name: string };
  product: { name: string } | null;
  assignedTo: { name: string } | null;
}) {
  return {
    id: lead.id,
    title: lead.title,
    name: lead.name,
    email: lead.email,
    phone: lead.phone,
    source: lead.source,
    status: lead.status,
    valueCents: lead.valueCents,
    quantity: lead.quantity,
    stageId: lead.stageId,
    stageName: lead.stage.name,
    productId: lead.productId,
    productName: lead.product?.name ?? null,
    assignedToId: lead.assignedToId,
    assignedToName: lead.assignedTo?.name ?? null,
    contactId: lead.contactId,
    updatedAt: lead.updatedAt.toISOString(),
  };
}

export async function loadJourneyContext(
  entityType: JourneyEntityType,
  entityId: string,
  event: Record<string, unknown> = {}
): Promise<JourneyContext | null> {
  const source = record(event.source);

  if (entityType === "system") {
    return { event, source, lead: null, contact: null };
  }

  if (entityType === "lead") {
    const lead = await prisma.lead.findUnique({
      where: { id: entityId },
      include: {
        stage: true,
        product: true,
        assignedTo: true,
        contact: {
          include: {
            tags: { select: { id: true, name: true } },
            vehicles: {
              where: { deletedAt: null },
              select: { id: true, model: true, purchaseDate: true },
            },
          },
        },
      },
    });
    if (!lead) return null;
    return {
      event,
      source,
      lead: compactLead(lead),
      contact: lead.contact ? compactContact(lead.contact) : null,
    };
  }

  const contact = await prisma.contact.findUnique({
    where: { id: entityId },
    include: {
      tags: { select: { id: true, name: true } },
      vehicles: {
        where: { deletedAt: null },
        select: { id: true, model: true, purchaseDate: true },
      },
      leads: {
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 1,
        include: { stage: true, product: true, assignedTo: true },
      },
    },
  });
  if (!contact) return null;
  const latestLead = contact.leads[0];
  return {
    event,
    source,
    contact: compactContact(contact),
    lead: latestLead ? compactLead(latestLead) : null,
  };
}

export function journeyTemplateVars(context: JourneyContext): Record<string, string> {
  const lead = record(context.lead);
  const contact = record(context.contact);
  const event = record(context.event);
  const source = record(context.source);
  const firstName = String(contact.firstName ?? String(lead.name ?? event.customerName ?? "").split(/\s+/)[0] ?? "there");
  const sourceLabel = source.reference ?? source.number ?? source.title ?? source.name ?? event.reference ?? event.sourceId ?? "";
  return {
    first_name: firstName || "there",
    name: String(contact.name ?? lead.name ?? event.customerName ?? "Customer"),
    email: String(contact.email ?? lead.email ?? event.email ?? ""),
    phone: String(contact.phone ?? contact.whatsapp ?? lead.phone ?? event.phone ?? ""),
    model: String(lead.productName ?? source.model ?? source.productName ?? event.model ?? "Denago vehicle"),
    stage: String(lead.stageName ?? event.stage ?? source.stage ?? ""),
    value: String(Math.round(Number(lead.valueCents ?? event.valueCents ?? 0) / 100)),
    company: String(contact.company ?? event.company ?? ""),
    event_type: String(event.type ?? ""),
    event_status: String(event.status ?? source.status ?? ""),
    event_reference: String(sourceLabel),
    branch: String(event.branch ?? source.branch ?? source.location ?? ""),
  };
}
