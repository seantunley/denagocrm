import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleContactIds, getAccessibleLeadIds, type PermissionUser } from "./permissions";

/**
 * The `notes` lookup: notes ADDED on a day (or a few), across every deal and customer the person may open, each
 * with who added it. Sean's 06:00 question — "Which notes were added to lead records yesterday? … who added each
 * note" — had no lookup that could answer it: message search is one customer at a time, and calendar activities
 * are not notes. READ-ONLY; nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
const DAY_MS = 86_400_000;
/** At most this many notes go back to DAX; more and the result says it was cut. */
export const NOTES_MAX = 40;

const saTime = (d: Date) =>
  d.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export async function notesLookup(user: PermissionUser, args: { from: string; to?: string; by?: string; limit?: number }): Promise<Output> {
  const start = new Date(`${args.from}T00:00:00+02:00`);
  const end = new Date(new Date(`${args.to ?? args.from}T00:00:00+02:00`).getTime() + DAY_MS);
  const take = Math.min(args.limit ?? NOTES_MAX, NOTES_MAX);
  // A note on a deal: the person may open that deal. A note on a customer with no deal: they may open the customer.
  const [leadIds, contactIds] = await Promise.all([getAccessibleLeadIds(user), getAccessibleContactIds(user)]);
  const onDeal = leadIds === null ? { leadId: { not: null } } : { leadId: { in: leadIds } };
  const onCustomer = contactIds === null ? { leadId: null, contactId: { not: null } } : { leadId: null, contactId: { in: contactIds } };
  const found = await prisma.communication.findMany({
    where: {
      tenantId: ownedWriteTenantId(),
      type: "note",
      createdAt: { gte: start, lt: end },
      OR: [onDeal, onCustomer],
      ...(args.by ? { user: { name: { contains: args.by.trim(), mode: "insensitive" as const } } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: take + 1,
    select: {
      id: true, body: true, createdAt: true, leadId: true, contactId: true,
      user: { select: { name: true } },
      lead: { select: { name: true, title: true } },
      contact: { select: { firstName: true, lastName: true, company: true } },
    },
  });
  const page = found.slice(0, take);
  const period = args.to && args.to !== args.from ? `${args.from} to ${args.to}` : args.from;
  if (!page.length) {
    return { rows: [], truncated: false, data: [{ period, ...(args.by ? { by: args.by } : {}), found: 0, note: `No notes were added ${args.by ? `by "${args.by}" ` : ""}on deals or customers you can open in that period.` }] };
  }
  const notes = page.map((n) => {
    const customer = n.lead?.name ?? ([n.contact?.firstName, n.contact?.lastName].filter(Boolean).join(" ") || n.contact?.company || "a customer");
    return {
      added: saTime(n.createdAt),
      on: customer,
      ...(n.lead?.title ? { deal: n.lead.title } : {}),
      by: n.user?.name ?? "unknown",
      note: clip(n.body.trim(), 400),
      link: n.leadId ? `/leads/${n.leadId}` : `/contacts/${n.contactId}`,
    };
  });
  return {
    truncated: found.length > take,
    data: [{ period, ...(args.by ? { by: args.by } : {}), found: found.length > take ? `more than ${take}` : page.length, notes }],
    rows: notes.map((n) => ({ label: `${n.on} — note by ${n.by}`, detail: `${n.added} · ${clip(n.note, 80)}`, href: n.link })),
  };
}
