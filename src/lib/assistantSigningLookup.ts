import "server-only";
import { prisma } from "./db";
import { ownedWriteTenantId } from "./tenantWrite";
import { getAccessibleQuoteIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { accessibleSignatureRequestWhere } from "./signing/access";
import { DELIVERY_NOTE } from "./signing/subject";

/**
 * EVERY signing request — delivery notes, contracts, custom documents and quotes — for DAX (Sean, 2026-11-14: "DAX
 * must have knowledge of those things, permission based"). It knew only whether a QUOTE was signed.
 *
 * HELD TO THE SIGNATURES PAGE'S OWN RULE: signing.view or signing.manage, and only the requests that page lists for
 * this person (accessibleSignatureRequestWhere — by the record each request is for, quote first). One rule stricter:
 * a delivery note is about a QUOTE (its subjectId), so it is shown only to someone who may open that quote.
 * The workspace is named in every query; access filters are ANDed, never spread.
 *
 * NEVER IN THE OUTPUT: signing tokens or links, email addresses, phone numbers, IP addresses, hashes, signature
 * images. Only names, states and dates. Nothing here is logged.
 */

type Output = { rows: { label: string; detail: string; href: string }[]; data: unknown[]; truncated: boolean };
export type SigningArgs = {
  status?: "waiting" | "viewed" | "completed" | "declined" | "expired" | "any";
  customer?: string;
  title?: string;
  from?: string;
  to?: string;
  limit?: number;
};

const DAY = 86_400_000;
const LIVE = ["sent", "viewed", "in_progress"];
const SIGNING_ROLES = ["signer", "approver"];
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const contains = (needle: string) => ({ contains: needle, mode: "insensitive" as const });

/** What each status asks for, as a request filter. "Viewed" is still waiting, and someone has opened it without signing. */
export function signingStatusWhere(status: SigningArgs["status"] = "waiting") {
  switch (status) {
    case "waiting": return { status: { in: LIVE } };
    case "viewed": return { status: { in: LIVE }, recipients: { some: { role: { in: SIGNING_ROLES }, status: "viewed" } } };
    case "completed": return { status: "completed" };
    case "declined": return { status: { in: ["declined", "rejected"] } };
    case "expired": return { status: "expired" };
    case "any": return {};
  }
}

export async function signingLookup(user: PermissionUser, args: SigningArgs): Promise<Output> {
  if (!(await hasAnyPermission(user, "signing.view", "signing.manage"))) {
    return { rows: [], data: [{ note: "This person can't open signing requests." }], truncated: false };
  }
  const tenantId = ownedWriteTenantId();
  const [mine, quoteIds] = await Promise.all([accessibleSignatureRequestWhere(user), getAccessibleQuoteIds(user)]);
  // A delivery note's quote is its subjectId: shown only with access to THAT quote. Spelled as an OR with the NULL
  // case named — a NOT over a nullable column would also drop every request with no subject at all.
  const deliveryNotes = quoteIds === null
    ? {}
    : { OR: [{ subjectType: null }, { subjectType: { not: DELIVERY_NOTE } }, { subjectId: { in: quoteIds } }] };

  let customer: object = {};
  if (args.customer) {
    const words = args.customer.split(/\s+/).filter(Boolean).slice(0, 4);
    const contacts = await prisma.contact.findMany({
      where: { tenantId, deletedAt: null, AND: words.map((w) => ({ OR: [{ firstName: contains(w) }, { lastName: contains(w) }, { company: contains(w) }] })) },
      select: { id: true },
      take: 50,
    });
    const contactIds = contacts.map((c) => c.id);
    const quotes = contactIds.length
      ? await prisma.quote.findMany({ where: { tenantId, contactId: { in: contactIds } }, select: { id: true }, take: 200 })
      : [];
    const ids = quotes.map((q) => q.id);
    customer = {
      OR: [
        { title: contains(args.customer) },
        { recipients: { some: { AND: words.map((w) => ({ name: contains(w) })) } } },
        ...(contactIds.length ? [{ contactId: { in: contactIds } }] : []),
        ...(ids.length ? [{ quoteId: { in: ids } }, { subjectType: DELIVERY_NOTE, subjectId: { in: ids } }] : []),
      ],
    };
  }
  const titleWords = args.title?.split(/\s+/).filter(Boolean).slice(0, 6) ?? [];
  const sentAt = {
    ...(args.from ? { gte: new Date(`${args.from}T00:00:00+02:00`) } : {}),
    ...(args.to ? { lt: new Date(new Date(`${args.to}T00:00:00+02:00`).getTime() + DAY) } : {}),
  };
  const where = {
    tenantId,
    deletedAt: null,
    AND: [
      mine,
      deliveryNotes,
      signingStatusWhere(args.status),
      customer,
      ...titleWords.map((w) => ({ title: contains(w) })),
      ...(Object.keys(sentAt).length ? [{ sentAt }] : []),
    ],
  };
  const take = Math.min(args.limit ?? 10, 60);
  const [requests, total] = await Promise.all([
    prisma.signatureRequest.findMany({
      where,
      orderBy: [{ sentAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take,
      select: {
        id: true, title: true, status: true, sentAt: true, completedAt: true, expiresAt: true, subjectType: true, subjectId: true, quoteId: true, jobCardId: true, documentId: true,
        recipients: { where: { role: { in: SIGNING_ROLES } }, orderBy: { order: "asc" }, select: { name: true, role: true, status: true, signedAt: true, viewedAt: true, declinedAt: true, remindedAt: true } },
      },
    }),
    prisma.signatureRequest.count({ where }),
  ]);

  const quoteRefs = [...new Set(requests.map((r) => r.quoteId ?? (r.subjectType === DELIVERY_NOTE ? r.subjectId : null)).filter((id): id is string => Boolean(id)))];
  const numbers = new Map(
    quoteRefs.length
      ? (await prisma.quote.findMany({ where: { tenantId, id: { in: quoteRefs } }, select: { id: true, number: true } })).map((q) => [q.id, q.number] as const)
      : [],
  );
  const forWhat = (r: (typeof requests)[number]) => {
    if (r.subjectType === DELIVERY_NOTE) return `delivery note${r.subjectId && numbers.has(r.subjectId) ? ` for Q-${numbers.get(r.subjectId)}` : ""}`;
    if (r.quoteId) return `quote${numbers.has(r.quoteId) ? ` Q-${numbers.get(r.quoteId)}` : ""}`;
    if (r.jobCardId) return "job card";
    return "document";
  };
  const state = (x: (typeof requests)[number]["recipients"][number]) =>
    x.status === "signed" ? `signed ${day(x.signedAt)}`
      : x.status === "declined" ? `declined ${day(x.declinedAt)}`
        : x.viewedAt ? `opened ${day(x.viewedAt)}, not signed`
          : x.status === "sent" ? "sent, not opened" : "not sent yet";
  const listed = requests.map((r) => {
    const reminded = r.recipients.map((x) => x.remindedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return {
      title: r.title,
      for: forWhat(r),
      status: r.status.replaceAll("_", " "),
      sent: day(r.sentAt),
      ...(r.completedAt ? { completed: day(r.completedAt) } : {}),
      ...(r.expiresAt && LIVE.includes(r.status) ? { expires: day(r.expiresAt) } : {}),
      signed: r.recipients.filter((x) => x.status === "signed").map((x) => `${x.name} (${state(x)})`),
      notSigned: r.recipients.filter((x) => x.status !== "signed").map((x) => `${x.name}${x.role === "approver" ? " (approver)" : ""}: ${state(x)}`),
      openedNotSigned: r.recipients.filter((x) => x.status !== "signed" && x.status !== "declined" && x.viewedAt).map((x) => x.name),
      lastReminder: reminded ? day(new Date(reminded)) : null,
      link: `/signatures/${r.id}`,
    };
  });
  return {
    truncated: total > requests.length,
    data: [{ total, listed: listed.length, showing: args.status ?? "waiting", requests: listed }],
    rows: listed.map((r, i) => ({ label: r.title, detail: `${r.for} · ${r.status}${r.notSigned.length ? ` · waiting on ${r.notSigned.length}` : ""}`, href: `/signatures/${requests[i].id}` })),
  };
}
