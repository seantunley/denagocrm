import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { readFile } from "./storage";
import { contactName } from "./format";
import { johannesburgDateKey } from "./activityDay";
import { ownedWriteTenantId } from "./tenantWrite";
import { resolveTenantActor } from "./tenantActor";
import { WHO_LEGEND, messageAuthor } from "./assistantWho";
import { openedFact } from "./emailOpenTracking";
import { isModuleEnabled } from "./modules/enabled";
import { isAutomotiveOwnedDocument } from "./modules/registry";
import { canAccessContact, getAccessibleContactIds, getAccessibleDocumentIds, getAccessibleLeadIds, hasAnyPermission, type PermissionUser } from "./permissions";
import { messageSearchArgs, openMessageArgs, readDocumentArgs } from "./crmAssistantPlan";
import type { AssistantRow } from "./crmAssistant";

/**
 * DAX's evidence lookups (roadmap Phase 2): search everything said to and from a
 * customer, read one message (or its thread) in full, and read the text of a PDF
 * on file with its page numbers.
 *
 * READ-ONLY, AND ONLY WHAT THE ASKER MAY SEE. Messages follow the timelines'
 * own rule (customerTimeline.ts): a customer's own entries, plus those on deals
 * this person may open — never another deal's. Documents go through
 * getAccessibleDocumentIds, the same list /api/files checks. Every query names
 * the workspace as well as running under RLS.
 *
 * NOTHING IS KEPT. PDF text is extracted when asked and dropped with the answer
 * (the encryption policy is untouched); failures log an error NAME, never a
 * word of a message or a document.
 *
 * CUSTOMER TEXT IS DATA. All of it reaches the model inside <crm_results> with
 * DATA_RULE (crmAssistantPlan), cleaned by observationText — and capped here,
 * per lookup, so one long email cannot crowd out the rest of the evidence.
 */

type ToolOutput = { rows: AssistantRow[]; data: unknown[]; truncated: boolean };
type User = PermissionUser;

/** Characters of message or document text one lookup may return. */
export const EVIDENCE_CHARS = 8000;
const SNIPPET_CHARS = 300;
const SEARCH_CANDIDATES = 200;
/** Pages read per call; later pages are asked for with fromPage. */
export const PDF_PAGES_PER_READ = 20;
/** Bigger than this is not opened at all (a PDF this size is almost always scans). */
export const PDF_MAX_BYTES = 15 * 1024 * 1024;
const PDF_TIMEOUT_MS = 20_000;
/** Less text than this across every page read = no text layer: a scan. */
const SCAN_TEXT_CHARS = 20;

/**
 * What a message is searched over. It MUST stay character-for-character the
 * expression in the Communication_search_idx migration, or Postgres will not use
 * the index (tests/assistantEvidence.test.ts pins the two together). Capped so
 * one enormous email can never exceed tsvector's 1 MB limit — which would fail
 * the INSERT that files it, not just the search.
 */
export const COMMUNICATION_SEARCH_DOC = `left(coalesce("subject", '') || ' ' || "body", 100000)`;
const SEARCH_DOC = Prisma.raw(COMMUNICATION_SEARCH_DOC);

const ID = /^c[a-z0-9]{20,}$/i;
const fuzzy = (needle: string) => ({ contains: needle, mode: "insensitive" as const });
const dateKey = (d: Date | null | undefined) => (d ? johannesburgDateKey(d) : "never");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const note = (text: string, extra: Record<string, unknown> = {}): ToolOutput => ({ truncated: false, rows: [], data: [{ note: text, ...extra }] });
const refused = (what: string) => note(`You don't have access to ${what}.`);

const SEARCH_STOP = new Set(["the", "and", "what", "did", "about", "with", "for", "was", "were", "that", "this", "have", "has", "had", "our", "you", "your", "they", "them", "their"]);

/**
 * The words worth searching for, each as a rough STEM: English full-text keeps
 * "delivery" and "delivered" apart ("deliveri" vs "deliv"), so each word is
 * also matched by its stem as a substring. At most 8; letters and digits only,
 * so a stem is always safe inside an ILIKE pattern.
 */
export function searchStems(words: string): string[] {
  const stems = words
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !SEARCH_STOP.has(w))
    .map((w) => {
      const stem = w.replace(/(ies|ied|ing|ery|ers|ed|es|er|ry|s|y|e)$/u, "");
      return stem.length >= 4 ? stem : w;
    });
  return [...new Set(stems)].slice(0, 8);
}

/** About SNIPPET_CHARS of `text` around the first stem found (the start when none is). */
export function snippetAround(text: string, stems: string[], size = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= size) return flat;
  const lower = flat.toLowerCase();
  const hits = stems.map((s) => lower.indexOf(s)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(at - Math.floor(size / 3), flat.length - size));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + size)}${start + size < flat.length ? "…" : ""}`;
}

/**
 * An outbound message's fate, in the only words the CRM can stand behind.
 * EMAIL is never "delivered" or "read": our mail server accepted it, it
 * bounced, an open was or wasn't detected, or the CRM can't tell. WhatsApp and
 * Messenger DO report receipts, so those are said as the platform said them.
 */
export function messageFacts(c: {
  type: string; direction: string | null; openToken?: string | null; messageId?: string | null;
  seenAt?: Date | null; openCount?: number; bouncedAt?: Date | null; bounceReason?: string | null; deliveredAt?: Date | null;
}): { status?: string } {
  if (c.direction !== "outbound") return {};
  if (c.type === "email") {
    const f = openedFact(c);
    if (!("emailOpen" in f)) return {};
    if (f.notDelivered) return { status: `bounced ${dateKey(c.bouncedAt)} — their mail server refused it, so they never got it${f.notDelivered.reason ? ` (${clip(f.notDelivered.reason, 160)})` : ""}` };
    const sent = f.provenance === "sent_by_crm" ? "accepted by our mail server" : "recorded on the timeline only — can't tell whether it was sent";
    const open = f.emailOpen === "opened"
      ? `open detected ${dateKey(c.seenAt)}${f.openedTimes ? ` (${f.openedTimes}×)` : ""} (a mail app loaded it — Apple Mail can, unopened)`
      : f.emailOpen === "no_open_detected" ? "no open detected (mail apps that block images report none)" : "can't tell whether it was opened";
    return { status: `${sent}; ${open}` };
  }
  if (["whatsapp", "messenger", "instagram"].includes(c.type)) {
    if (c.seenAt) return { status: `${c.type} reports it was read ${dateKey(c.seenAt)}` };
    if (c.deliveredAt) return { status: `${c.type} reports it reached their phone ${dateKey(c.deliveredAt)}` };
    return { status: `no receipt from ${c.type} — can't tell whether it reached them` };
  }
  return {};
}

/* ── Whose messages ─────────────────────────────────────────────────────── */

/**
 * The messages one customer's search may return: their own entries (on no
 * deal) and those on `leadIds` — their deals this person may open. A deal with
 * no customer is just its own entries (contactId null).
 */
type MessageScope = { label: string; link: string; contactId: string | null; leadIds: string[] };

async function messageScope(user: User, needle: string): Promise<MessageScope | ToolOutput> {
  const canLeads = await hasAnyPermission(user, "leads.view_all", "leads.view_owned");
  const [leadIds, contactIds] = await Promise.all([canLeads ? getAccessibleLeadIds(user) : Promise.resolve([] as string[]), getAccessibleContactIds(user)]);
  const leadVisible = leadIds === null ? {} : { id: { in: leadIds } };
  const looksLikeId = ID.test(needle);
  const words = needle.split(/\s+/).filter(Boolean).slice(0, 4);
  const [leads, contacts] = await Promise.all([
    leadIds !== null && leadIds.length === 0
      ? Promise.resolve([])
      : prisma.lead.findMany({
          where: {
            deletedAt: null,
            AND: [
              leadVisible,
              // lead_brief's own matching: a lead id, a customer's id, or the name.
              looksLikeId
                ? { OR: [{ id: needle }, { contactId: needle }] }
                : { OR: [{ name: fuzzy(needle) }, { title: fuzzy(needle) }, { contact: { OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }] } }] },
            ],
          },
          orderBy: { updatedAt: "desc" },
          take: 6,
          select: { id: true, name: true, title: true, contactId: true },
        }),
    contactIds !== null && contactIds.length === 0
      ? Promise.resolve([])
      : prisma.contact.findMany({
          where: {
            deletedAt: null,
            // AND, never spread: `{ id: needle }` spread after `{ id: { in: contactIds } }` would replace the access filter.
            AND: [
              ...(contactIds === null ? [] : [{ id: { in: contactIds } }]),
              // customersNamed's matching: every word in the first name, last name or company.
              ...(looksLikeId ? [{ id: needle }] : words.map((w) => ({ OR: [{ firstName: fuzzy(w) }, { lastName: fuzzy(w) }, { company: fuzzy(w) }] }))),
            ],
          },
          orderBy: { updatedAt: "desc" },
          take: 6,
          select: { id: true, firstName: true, lastName: true, company: true },
        }),
  ]);
  // One customer per key: a contact, or a deal with no contact.
  const people = new Map<string, { contactId: string | null; leadId?: string; name: string }>();
  for (const c of contacts) people.set(c.id, { contactId: c.id, name: contactName(c) || c.company || "a customer" });
  for (const l of leads) {
    const key = l.contactId ?? `lead:${l.id}`;
    if (!people.has(key)) people.set(key, { contactId: l.contactId, leadId: l.contactId ? undefined : l.id, name: l.name || l.title });
  }
  if (people.size === 0) return note(`No customer or deal you can see matches "${needle}".`);
  if (people.size > 1) {
    return note("Several customers match — ask which one (then search again with its id).", {
      candidates: [...people.values()].slice(0, 5).map((p) => ({ name: p.name, id: p.contactId ?? p.leadId })),
    });
  }
  const [only] = people.values();
  if (!only.contactId) return { label: only.name, link: `/leads/${only.leadId}`, contactId: null, leadIds: [only.leadId!] };
  // Their deals this person may open; a deal they cannot open contributes nothing.
  const theirDeals = !canLeads || (leadIds !== null && leadIds.length === 0)
    ? []
    : await prisma.lead.findMany({ where: { contactId: only.contactId, deletedAt: null, ...leadVisible }, select: { id: true } });
  return { label: only.name, link: `/contacts/${only.contactId}`, contactId: only.contactId, leadIds: theirDeals.map((l) => l.id) };
}

/**
 * May this person see this one message? The same rule as the search, for a row
 * reached by id: on a deal → they may open that deal; on the customer only →
 * they may open the customer, or one of the customer's deals (whose timeline
 * shows it). On neither (an unmatched inbox message) → no.
 */
async function messageVisible(user: User, row: { leadId: string | null; contactId: string | null }, leadIds: string[] | null): Promise<boolean> {
  if (row.leadId) return leadIds === null || leadIds.includes(row.leadId);
  if (!row.contactId) return false;
  if (await canAccessContact(user, row.contactId)) return true;
  if (leadIds !== null && leadIds.length === 0) return false;
  const deal = await prisma.lead.findFirst({ where: { contactId: row.contactId, deletedAt: null, ...(leadIds === null ? {} : { id: { in: leadIds } }) }, select: { id: true } });
  return deal !== null;
}

/* ── search_messages ────────────────────────────────────────────────────── */

type SearchRow = {
  id: string; occurredAt: Date; direction: string | null; type: string; subject: string | null; body: string;
  leadId: string | null; userId: string; openToken: string | null; messageId: string | null; seenAt: Date | null; openCount: number;
  bouncedAt: Date | null; bounceReason: string | null; deliveredAt: Date | null; rank: number;
};

export async function searchMessages(user: User, raw: z.infer<typeof messageSearchArgs>): Promise<ToolOutput> {
  const args = messageSearchArgs.parse(raw);
  const scope = await messageScope(user, args.customer);
  if (!("leadIds" in scope)) return scope;
  const stems = args.words ? searchStems(args.words) : [];
  const search = stems.join(" or ");
  const take = args.limit ?? 10;
  const tenantId = ownedWriteTenantId();
  // The workspace is written into the statement itself (below), where the tenant-access sweep can read it.
  const conditions = [
    scope.contactId
      ? Prisma.sql`(("contactId" = ${scope.contactId} AND "leadId" IS NULL) OR "leadId" = ANY(${scope.leadIds}::text[]))`
      : Prisma.sql`"leadId" = ANY(${scope.leadIds}::text[])`,
    ...(args.channel ? [Prisma.sql`"type" = ${args.channel.toLowerCase()}`] : []),
    ...(args.direction ? [Prisma.sql`"direction" = ${args.direction}`] : []),
    // Calendar days in South Africa: `to` includes the whole of that day.
    ...(args.from ? [Prisma.sql`"occurredAt" >= ${new Date(`${args.from}T00:00:00+02:00`)}`] : []),
    ...(args.to ? [Prisma.sql`"occurredAt" < ${new Date(new Date(`${args.to}T00:00:00+02:00`).getTime() + 86_400_000)}`] : []),
    // Full-text (stems: "promised" finds "promise"), the stem as a substring
    // ("deliv" finds delivery AND delivered), or a close spelling (pg_trgm).
    ...(stems.length
      ? [Prisma.sql`(
          to_tsvector('english', ${SEARCH_DOC}) @@ websearch_to_tsquery('english', ${search})
          OR EXISTS (SELECT 1 FROM unnest(${stems}::text[]) AS w WHERE ${SEARCH_DOC} ILIKE '%' || w || '%' OR w <% ${SEARCH_DOC})
        )`]
      : []),
  ];
  // ponytail: one customer's messages are a few hundred at most, ranked in memory; a workspace-wide search would rank in SQL.
  const found = await prisma.$queryRaw<SearchRow[]>`
    SELECT "id", "occurredAt", "direction", "type", "subject", "body", "leadId", "userId",
           "openToken", "messageId", "seenAt", "openCount", "bouncedAt", "bounceReason", "deliveredAt",
           ${stems.length ? Prisma.sql`ts_rank(to_tsvector('english', ${SEARCH_DOC}), websearch_to_tsquery('english', ${search}))::float8` : Prisma.sql`0::float8`} AS "rank"
      FROM "Communication"
     WHERE "tenantId" = ${tenantId}
       AND ${Prisma.join(conditions, " AND ")}
     ORDER BY "occurredAt" DESC
     LIMIT ${SEARCH_CANDIDATES}`;
  // Best first: how many of the words it holds, then Postgres' rank, then newest.
  const hits = (r: SearchRow) => {
    const text = `${r.subject ?? ""} ${r.body}`.toLowerCase();
    return stems.filter((s) => text.includes(s)).length;
  };
  const ranked = stems.length
    ? [...found].sort((a, b) => hits(b) - hits(a) || b.rank - a.rank || b.occurredAt.getTime() - a.occurredAt.getTime())
    : found;
  const page = ranked.slice(0, take);
  const [standIn, authors, deals] = await Promise.all([
    resolveTenantActor().catch(() => null),
    page.length ? prisma.user.findMany({ where: { id: { in: [...new Set(page.map((r) => r.userId))] } }, select: { id: true, name: true } }) : [],
    scope.leadIds.length ? prisma.lead.findMany({ where: { id: { in: scope.leadIds } }, select: { id: true, title: true } }) : [],
  ]);
  const author = new Map(authors.map((u) => [u.id, u]));
  const dealTitle = new Map(deals.map((d) => [d.id, d.title]));
  if (!page.length) {
    return note(`No message${stems.length ? ` with ${stems.map((s) => `"${s}…"`).join(" or ")}` : ""} to or from ${scope.label} matches. (Words are matched by stem and close spelling, not by meaning — try other words before saying it was never said.)`, { customer: scope.label, link: scope.link });
  }
  return {
    truncated: found.length > take,
    data: [{
      customer: scope.label,
      link: scope.link,
      found: found.length === SEARCH_CANDIDATES ? `at least ${SEARCH_CANDIDATES}` : found.length,
      note: "Excerpts only — open_message reads one in full. An older message can be out of date: check what was said against today's record (the quote, the deal) before relying on it, and say when it was said and by whom.",
      who: WHO_LEGEND,
      messages: page.map((r) => {
        const { from, loggedBy } = messageAuthor({ ...r, user: author.get(r.userId) ?? null }, standIn?.id ?? null);
        return {
          id: r.id,
          when: dateKey(r.occurredAt),
          channel: r.type,
          from,
          ...(loggedBy ? { loggedBy } : {}),
          ...(r.leadId && dealTitle.get(r.leadId) ? { deal: dealTitle.get(r.leadId) } : {}),
          ...(r.subject ? { subject: clip(r.subject, 140) } : {}),
          excerpt: snippetAround(r.body, stems),
          ...messageFacts(r),
        };
      }),
    }],
    rows: [{ label: `${scope.label} — messages`, detail: `${found.length} found`, href: scope.link }],
  };
}

/* ── open_message ───────────────────────────────────────────────────────── */

const MESSAGE_SELECT = {
  id: true, occurredAt: true, direction: true, type: true, subject: true, body: true, leadId: true, contactId: true,
  conversationId: true, cc: true, attachmentType: true,
  openToken: true, messageId: true, seenAt: true, openCount: true, bouncedAt: true, bounceReason: true, deliveredAt: true,
  user: { select: { id: true, name: true } },
} as const;
const THREAD_MESSAGES = 15;

export async function openMessage(user: User, raw: z.infer<typeof openMessageArgs>): Promise<ToolOutput> {
  const { id, thread } = openMessageArgs.parse(raw);
  const tenantId = ownedWriteTenantId();
  const canLeads = await hasAnyPermission(user, "leads.view_all", "leads.view_owned");
  const leadIds = canLeads ? await getAccessibleLeadIds(user) : [];
  const message = await prisma.communication.findFirst({ where: { id, tenantId }, select: MESSAGE_SELECT });
  // Missing, another workspace's, or not yours to see: one answer, so an id says nothing about what exists.
  if (!message || !(await messageVisible(user, message, leadIds))) return note("No message with that id that you can see.");
  const standIn = (await resolveTenantActor().catch(() => null))?.id ?? null;

  let others: (typeof message)[] = [];
  if (thread && message.conversationId) {
    const around = await prisma.communication.findMany({
      where: { tenantId, conversationId: message.conversationId, id: { not: message.id } },
      orderBy: { occurredAt: "asc" },
      take: 60,
      select: MESSAGE_SELECT,
    });
    // The nearest in time first, each checked like the one asked for.
    const nearest = around.sort((a, b) => Math.abs(a.occurredAt.getTime() - message.occurredAt.getTime()) - Math.abs(b.occurredAt.getTime() - message.occurredAt.getTime()));
    for (const m of nearest) {
      if (others.length >= THREAD_MESSAGES) break;
      if (await messageVisible(user, m, leadIds)) others.push(m);
    }
    others.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
  // The character budget: the message asked for first, the thread shares what is left.
  const ownShare = others.length ? Math.floor(EVIDENCE_CHARS * 0.6) : EVIDENCE_CHARS;
  const ownText = clip(message.body, ownShare);
  const each = others.length ? Math.max(200, Math.floor((EVIDENCE_CHARS - ownText.length) / others.length)) : 0;
  const shape = (m: typeof message, max: number) => {
    const { from, loggedBy } = messageAuthor(m, standIn);
    return {
      id: m.id,
      when: dateKey(m.occurredAt),
      channel: m.type,
      from,
      ...(loggedBy ? { loggedBy } : {}),
      ...(m.subject ? { subject: clip(m.subject, 200) } : {}),
      ...(m.cc ? { copied: "others were copied in" } : {}),
      ...(m.attachmentType ? { attachment: `${m.attachmentType} (not read)` } : {}),
      text: clip(m.body, max),
      ...(m.body.length > max ? { cut: `${m.body.length - max} more characters not shown` } : {}),
      ...messageFacts(m),
    };
  };
  const link = message.leadId ? `/leads/${message.leadId}` : `/contacts/${message.contactId}`;
  return {
    truncated: message.body.length > ownShare,
    data: [{
      link,
      title: message.subject ?? `${message.type} ${dateKey(message.occurredAt)}`,
      who: WHO_LEGEND,
      message: shape(message, ownShare),
      ...(thread ? { thread: message.conversationId ? others.map((m) => shape(m, each)) : "This message is not part of a conversation thread." } : {}),
    }],
    rows: [{ label: message.subject ? clip(message.subject, 60) : `${message.type} message`, detail: dateKey(message.occurredAt), href: link }],
  };
}

/* ── read_document ──────────────────────────────────────────────────────── */

type PdfPage = { page: number; text: string };
/** Why a PDF could not be read, in words the answer can repeat. */
export class PdfUnreadable extends Error {
  constructor(public readonly reason: "password" | "damaged" | "timeout") {
    super(reason);
    this.name = "PdfUnreadable";
  }
}

/**
 * The text of pages `from`…`from + PDF_PAGES_PER_READ - 1`, page by page, and
 * how many pages there are. Pure apart from unpdf (PDF.js built for serverless:
 * no worker, no canvas). Never keeps anything.
 */
export async function pdfPages(bytes: Uint8Array, from = 1): Promise<{ totalPages: number; pages: PdfPage[] }> {
  const { getDocumentProxy } = await import("unpdf");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfUnreadable("timeout")), PDF_TIMEOUT_MS);
  });
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await Promise.race([getDocumentProxy(bytes), timeout]).catch((error: unknown) => {
      if (error instanceof PdfUnreadable) throw error;
      throw new PdfUnreadable(error instanceof Error && error.name === "PasswordException" ? "password" : "damaged");
    });
    const doc = pdf;
    const last = Math.min(doc.numPages, from + PDF_PAGES_PER_READ - 1);
    const pages: PdfPage[] = [];
    for (let n = from; n <= last; n++) {
      const content = await Promise.race([doc.getPage(n).then((p) => p.getTextContent()), timeout]);
      const text = content.items
        .map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : ""))
        .join("")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*/g, "\n")
        .trim();
      pages.push({ page: n, text });
    }
    return { totalPages: doc.numPages, pages };
  } finally {
    clearTimeout(timer);
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}

export async function readDocument(user: User, raw: z.infer<typeof readDocumentArgs>): Promise<ToolOutput> {
  if (!(await hasAnyPermission(user, "documents.view_all", "documents.view_owned"))) return refused("documents");
  const args = readDocumentArgs.parse(raw);
  const docIds = await getAccessibleDocumentIds(user);
  if (docIds !== null && docIds.length === 0) return note("There are no documents you can open.");
  const tenantId = ownedWriteTenantId();
  const words = args.document.split(/\s+/).filter(Boolean).slice(0, 6);
  const customerWords = args.customer?.split(/\s+/).filter(Boolean).slice(0, 4) ?? [];
  const docs = await prisma.document.findMany({
    where: {
      tenantId,
      deletedAt: null,
      // AND, never spread: a spread `{ id: <asked for> }` would REPLACE `{ id: { in: docIds } }` — the access filter —
      // and hand anyone any document in the workspace by its id (caught by test-assistant-evidence).
      AND: [
        ...(docIds === null ? [] : [{ id: { in: docIds } }]),
        ...(ID.test(args.document)
          ? [{ id: args.document }]
          : [
              { replacedById: null },
              ...words.map((w) => ({ fileName: fuzzy(w) })),
              ...(customerWords.length ? [{ contact: { AND: customerWords.map((w) => ({ OR: [{ firstName: fuzzy(w) }, { lastName: fuzzy(w) }, { company: fuzzy(w) }] })) } }] : []),
            ]),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 6,
    select: { id: true, fileName: true, storedName: true, mimeType: true, sizeBytes: true, tenantId: true, createdAt: true, vehicleId: true, jobCardId: true, tag: true, contactId: true },
  });
  // Vehicle and job-card paperwork belongs to the Automotive module: off, it isn't there (as /api/files says).
  const automotive = docs.some(isAutomotiveOwnedDocument) ? await isModuleEnabled("automotive") : true;
  const visible = docs.filter((d) => automotive || !isAutomotiveOwnedDocument(d));
  if (!visible.length) return note(`No document you can open matches "${args.document}". The documents lookup lists what is on file for a customer, with each documentId.`);
  if (visible.length > 1) {
    return note("Several documents match — ask which one (then read it by its documentId).", {
      candidates: visible.slice(0, 5).map((d) => ({ documentId: d.id, file: d.fileName, added: dateKey(d.createdAt) })),
    });
  }
  const doc = visible[0];
  const link = `/api/files/${doc.id}`;
  const about = { document: doc.fileName, title: doc.fileName, link, added: dateKey(doc.createdAt) };
  const isPdf = /^application\/pdf$/i.test(doc.mimeType) || /\.pdf$/i.test(doc.fileName);
  if (!isPdf) return note(`"${doc.fileName}" is not a PDF — only a PDF's text can be read. Open it to look at it.`, about);
  if (doc.sizeBytes > PDF_MAX_BYTES) return note(`"${doc.fileName}" is too big to read here (over ${PDF_MAX_BYTES / 1024 / 1024} MB). Open it to look at it.`, about);

  let read: Awaited<ReturnType<typeof pdfPages>>;
  try {
    // Checked against the RECORD's workspace, exactly as /api/files reads it.
    const bytes = await readFile(doc.storedName, doc.tenantId);
    read = await pdfPages(new Uint8Array(bytes), args.fromPage ?? 1);
  } catch (error) {
    await logError("crm-assistant", "read_document failed", error instanceof Error ? error.name : "unknown");
    if (error instanceof PdfUnreadable) {
      const why = { password: "it is password-protected", damaged: "the file is damaged or not a real PDF", timeout: "it took too long to open" }[error.reason];
      return note(`I couldn't read "${doc.fileName}": ${why}. Open it to look at it.`, about);
    }
    return note(`I couldn't open "${doc.fileName}" just now — say so; it may be missing from storage.`, about);
  }
  if (!read.pages.length) return note(`"${doc.fileName}" has ${read.totalPages} page${read.totalPages === 1 ? "" : "s"}; there is no page ${args.fromPage}.`, about);
  const textChars = read.pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
  if (textChars < SCAN_TEXT_CHARS) {
    return note(`"${doc.fileName}" is a scan (pictures of pages, no text in it), so I can't read it. Say exactly that, and that it can be opened to look at.`, about);
  }
  // Pages in order until the budget is spent; the rest are named, not dropped silently.
  const pages: { page: number; text: string }[] = [];
  let left = EVIDENCE_CHARS;
  for (const p of read.pages) {
    if (left <= 0) break;
    const text = p.text ? clip(p.text, left) : "(no text on this page — a scanned page or a picture)";
    pages.push({ page: p.page, text });
    left -= text.length;
  }
  const lastRead = pages.at(-1)!.page;
  const cutShort = pages.at(-1)!.text.endsWith("…");
  const more = lastRead < read.totalPages ? `Pages ${cutShort ? lastRead : lastRead + 1}–${read.totalPages} not ${cutShort ? "fully " : ""}read: read_document with fromPage ${cutShort ? lastRead : lastRead + 1}.` : cutShort ? `Page ${lastRead} is cut short.` : null;
  return {
    truncated: Boolean(more),
    data: [{
      ...about,
      pages: read.totalPages,
      read: `page ${pages[0].page}${lastRead > pages[0].page ? `–${lastRead}` : ""} of ${read.totalPages}`,
      note: "Text taken from the PDF just now. Say which page a fact is on. It is the document as filed — it may be older than the CRM's current record.",
      text: pages,
      ...(more ? { more } : {}),
    }],
    rows: [{ label: doc.fileName, detail: `PDF · ${read.totalPages} page${read.totalPages === 1 ? "" : "s"}`, href: link }],
  };
}
