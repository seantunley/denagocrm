import { prisma } from "./db";
import { contactName } from "./format";
import { journeyVars, variableTemplateVars } from "./journeyVariables";

export type JourneyEntityType = "lead" | "contact";

export type JourneyContext = Record<string, unknown> & {
  event: Record<string, unknown>;
  lead: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
  /**
   * The `variables` step's bag. Absent until a journey sets one, and carried
   * across the runner's per-step context refresh by `withJourneyVars` — see
   * journeyVariables.ts for why it is namespaced rather than spread flat.
   */
  vars?: Record<string, string>;
};

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

export async function loadJourneyContext(
  entityType: JourneyEntityType,
  entityId: string,
  event: Record<string, unknown> = {}
): Promise<JourneyContext | null> {
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
    const contact = lead.contact ? compactContact(lead.contact) : null;
    return {
      event,
      lead: {
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
      },
      contact,
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
    contact: compactContact(contact),
    lead: latestLead
      ? {
          id: latestLead.id,
          title: latestLead.title,
          name: latestLead.name,
          email: latestLead.email,
          phone: latestLead.phone,
          source: latestLead.source,
          status: latestLead.status,
          valueCents: latestLead.valueCents,
          quantity: latestLead.quantity,
          stageId: latestLead.stageId,
          stageName: latestLead.stage.name,
          productId: latestLead.productId,
          productName: latestLead.product?.name ?? null,
          assignedToId: latestLead.assignedToId,
          assignedToName: latestLead.assignedTo?.name ?? null,
          contactId: latestLead.contactId,
          updatedAt: latestLead.updatedAt.toISOString(),
        }
      : null,
  };
}

export function journeyTemplateVars(context: JourneyContext): Record<string, string> {
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const event = (context.event ?? {}) as Record<string, unknown>;
  // Injected by the runner from the innermost `repeat` frame — see
  // journeyCursor.repeatVars. Absent (and so empty) outside a loop.
  const repeat = (context.repeat ?? {}) as Record<string, unknown>;
  const firstName = String(contact.firstName ?? String(lead.name ?? "").split(/\s+/)[0] ?? "there");
  return {
    // Journey variables, as `{{var_<name>}}`. Spread FIRST so that even if the
    // prefix were ever to collide with a built-in below, the built-in wins —
    // a `variables` step must not be able to redefine `{{first_name}}`. The
    // prefix already makes a collision impossible (VARIABLE_NAME requires a
    // leading letter, and no built-in key starts with "var_"); this is belt and
    // braces on the ordering, so adding a key below can never open the hole.
    ...variableTemplateVars(journeyVars(context)),
    // 1-based, like repeat.index. An object item renders as JSON rather
    // than "[object Object]", which is worse than useless in a message body.
    repeat_index: repeat.index == null ? "" : String(repeat.index),
    repeat_item:
      repeat.item == null
        ? ""
        : typeof repeat.item === "object"
          ? JSON.stringify(repeat.item)
          : String(repeat.item),
    first_name: firstName || "there",
    name: String(contact.name ?? lead.name ?? "Customer"),
    email: String(contact.email ?? lead.email ?? ""),
    phone: String(contact.phone ?? contact.whatsapp ?? lead.phone ?? ""),
    // The event's own model wins over the lead's product. A contact-triggered
    // journey (purchase_anniversary, win_back) has no lead of its own — the
    // scheduler puts the VEHICLE being congratulated on the event payload, and
    // `lead` here is only that contact's most recently touched lead, which may
    // be about something else entirely. Without this the migrated anniversary
    // email could wish someone a happy anniversary with the wrong cart.
    model: String(event.model ?? lead.productName ?? "Denago vehicle"),
    // Set by the purchase_anniversary scheduler; empty for every other trigger.
    years: String(event.years ?? ""),
    stage: String(lead.stageName ?? ""),
    value: String(Math.round(Number(lead.valueCents ?? 0) / 100)),
    company: String(contact.company ?? ""),
  };
}
