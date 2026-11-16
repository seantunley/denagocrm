import "server-only";
import { prisma } from "../db";
import { logError } from "../errorLog";
import { johannesburgDateKey } from "../activityDay";
import { listActingTenantStaff } from "../tenantActor";
import { ownedWriteTenantId } from "../tenantWrite";
import { liveTurnsWhere } from "../assistantConversation";
import { accessibleTestDriveWhere } from "../testDriveAccess";
import { canAccessConversation, canAccessLead, canAccessQuote, canAccessVehicle, hasAnyPermission } from "../permissions";
import { stripInvisible } from "../invisibleText";
import { splitListed } from "../assistantListedRules";
import { type PriorTurn } from "../crmAssistantPlan";
import { DAY, HISTORY_DAYS, ToolOutput, User } from "./lookupKit";
import { when } from "./lookups/schedule";

/** Turns this recent are "the conversation"; older ones are only reachable via recall. */
export const CONVERSATION_WINDOW_MS = 3 * 60 * 60 * 1000;
/** What one tool's results may cost in a prompt. */
export const OBSERVATION_CHARS = 7000;
/**
 * The evidence lookups carry up to EVIDENCE_CHARS of customer or document text
 * (capped by the tools themselves, so the cut lands between messages or pages,
 * not mid-JSON) — this is the ceiling with their dates, ids and facts around it.
 */
// find_leads: room for a report's full list (LEAD_LIST_MAX rows) — at 7 000 a list was cut near 20 (2026-11-14).
export const OBSERVATION_BUDGET: Partial<Record<string, number>> = { search_messages: 12_000, search_everything: 12_000, open_message: 11_000, read_document: 11_000, find_leads: 24_000 };
/** The same shape with nothing read — for a route that never researches (assistantFollowUp). */
export async function quietContext(user: User): Promise<Awaited<ReturnType<typeof planContext>>> {
  return { today: johannesburgDateKey(new Date()), userName: user.name || "the user", stages: [], staff: [], activityTypes: [] };
}

/** The workspace facts the research step needs to map names to real values. */
export async function planContext(user: User) {
  const [stages, staff, types] = await Promise.all([
    prisma.pipelineStage.findMany({ select: { name: true }, orderBy: { order: "asc" } }),
    listActingTenantStaff(),
    prisma.activity.findMany({ distinct: ["type"], select: { type: true }, take: 30 }),
  ]);
  return {
    today: johannesburgDateKey(new Date()),
    userName: user.name || "the user",
    stages: [...new Set(stages.map((s) => s.name))],
    // Sorted: the database returns these in no fixed order, and a list that
    // reshuffles between calls changes the prompt and defeats its cache.
    staff: staff.map((s) => s.name).sort((a, b) => a.localeCompare(b)),
    activityTypes: types.map((t) => t.type).sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Who the assistant is talking WITH — the last layer after the business (soul,
 * workspace instructions, company, what it knows about the business): their job
 * title, their teams, whether they see everything. What they've told it or it
 * has learned about them (their profile notes) follows in the learned block.
 * Only this person's own record; teams through the tenant-scoped client.
 */
export async function personContext(user: User): Promise<string> {
  const [me, memberships, manages] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { jobTitle: true } }),
    prisma.teamMember.findMany({ where: { userId: user.id, team: { active: true, deletedAt: null } }, select: { team: { select: { name: true } } }, take: 10 }),
    prisma.team.findMany({ where: { managerId: user.id, active: true, deletedAt: null }, select: { name: true }, take: 10 }),
  ]);
  return describePerson({
    name: user.name || "this person",
    jobTitle: me?.jobTitle ?? null,
    sees: user.role === "owner" ? "everything" : "their own",
    teams: [...new Set(memberships.map((m) => m.team.name))],
    manages: manages.map((t) => t.name),
  });
}

export function describePerson(p: { name: string; jobTitle: string | null; sees: "everything" | "their own"; teams: string[]; manages: string[] }): string {
  const role = p.jobTitle?.trim() ? `${p.name}, ${p.jobTitle.trim().slice(0, 80)}` : p.name;
  return [
    `THE PERSON YOU'RE TALKING WITH: ${role}.`,
    p.sees === "everything" ? "They can see everything in this workspace." : "They see the records their access allows — answer about those, never about anyone else's.",
    p.teams.length ? `Their team${p.teams.length === 1 ? "" : "s"}: ${p.teams.join(", ")}.` : "",
    p.manages.length ? `They manage: ${p.manages.join(", ")} — "my team" means the people in it.` : "",
    "Make your answers theirs — their deals, their team, the way they like it — without reciting this back.",
  ].filter(Boolean).join(" ");
}

/** This person's turns in the current conversation (the last few hours), oldest first. */
export async function recentTurns(userId: string): Promise<PriorTurn[]> {
  const live = await liveTurnsWhere(ownedWriteTenantId(), userId);
  const turns = await prisma.assistantTurn.findMany({
    // Never from a conversation its person deleted.
    where: { userId, createdAt: { gte: new Date(Date.now() - CONVERSATION_WINDOW_MS) }, AND: [live] },
    orderBy: { createdAt: "desc" },
    take: 6,
    // state: the working memory each answer wrote (parsed and cleaned before
    // it was saved); conversationBlock leads with the latest one.
    select: { question: true, answer: true, state: true },
  });
  return withListed(turns.reverse());
}

/** The records each answer listed travel apart from its working memory (assistantListedRules). */
export function withListed(turns: { question: string; answer: string; state: unknown }[]): PriorTurn[] {
  return turns.map((t) => {
    const { listed, rest } = splitListed(t.state);
    return { ...t, state: rest as PriorTurn["state"], listed };
  });
}

/**
 * The bubble's history: only TODAY's turns (South African day), newest first —
 * enough to pick up where you left off, never a month of context.
 */
export async function assistantTurnsToday(userId: string) {
  const startOfToday = new Date(`${johannesburgDateKey(new Date())}T00:00:00+02:00`);
  return prisma.assistantTurn.findMany({
    where: { userId, createdAt: { gte: startOfToday } },
    orderBy: { createdAt: "desc" },
    take: 20,
    // `source`, so a scheduled answer is labelled as one in the thread; `id`, so the last question can be edited.
    select: { id: true, question: true, answer: true, source: true },
  });
}

/**
 * Where the person is when they ask from the bubble — "this lead", "her" — as a
 * hint for the research step. Only a record id from the URL; the tools still
 * check access, so a hint about a record they can't see finds nothing.
 */
export function pageHint(path: string | null | undefined): string {
  const match = /^\/(leads|contacts)\/(c[a-z0-9]{20,})(?:[/?#]|$)/i.exec(path ?? "");
  if (!match) return "";
  return `The person is looking at ${match[1] === "leads" ? "lead" : "customer"} id ${match[2]} — "this", "him", "her", "them" mean that record (use lead_brief with that id).`;
}

export const ID = "c[a-z0-9]{20,}";
/** What kind of page a path is, and the record on it — pure, from the URL alone. */
export type PageTarget =
  | { kind: "lead" | "contact" | "quote" | "test_drive" | "vehicle" | "stock" | "signing" | "conversation"; id: string }
  | { kind: "calendar" | "deliveries" | "inbox" | "leads_board" | "quotes" | "today" | "attention" | "test_drives" | "home" }
  | null;

export function pageTarget(page: string | null | undefined): PageTarget {
  const raw = page ?? "";
  const q = raw.indexOf("?");
  const path = (q === -1 ? raw : raw.slice(0, q)).replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  const record: [RegExp, Extract<PageTarget, { id: string }>["kind"]][] = [
    [new RegExp(`^/leads/(${ID})(?:/|$)`, "i"), "lead"],
    [new RegExp(`^/contacts/(${ID})(?:/|$)`, "i"), "contact"],
    [new RegExp(`^/quotes/(${ID})(?:/|$)`, "i"), "quote"],
    [new RegExp(`^/test-drives/(${ID})(?:/|$)`, "i"), "test_drive"],
    [new RegExp(`^/vehicles/(${ID})(?:/|$)`, "i"), "vehicle"],
    [new RegExp(`^/stock/(${ID})(?:/|$)`, "i"), "stock"],
    [new RegExp(`^/signatures/(${ID})(?:/|$)`, "i"), "signing"],
  ];
  for (const [re, kind] of record) {
    const m = re.exec(path);
    if (m) return { kind, id: m[1] };
  }
  const idParam = (name: string) => {
    const v = params.get(name);
    return v && new RegExp(`^${ID}$`, "i").test(v) ? v : null;
  };
  if (path === "/quotes") {
    const edit = idParam("edit");
    return edit ? { kind: "quote", id: edit } : { kind: "quotes" };
  }
  if (path === "/inbox") {
    const conversation = idParam("conversation");
    return conversation ? { kind: "conversation", id: conversation } : { kind: "inbox" };
  }
  const lists: Record<string, Exclude<PageTarget, null | { id: string }>["kind"]> = {
    "/calendar": "calendar", "/activities": "calendar", "/deliveries": "deliveries", "/leads": "leads_board",
    "/leads/list": "leads_board", "/today": "today", "/leads/attention": "attention", "/test-drives": "test_drives", "/": "home",
  };
  return lists[path] ? { kind: lists[path] } : null;
}

/**
 * Where the person is, as a hint for the research step: on a lead or customer
 * (pageHint), but also on a quote, a test drive, a vehicle, a stock unit, a
 * signing request or an inbox conversation — each resolved to the lead or
 * customer behind it, so "this one" reads the right record — or on a list
 * page ("which of these?"). Every record is checked against what the person
 * may open first; one they can't gives no hint at all. Never a customer's
 * contact details, only names and ids the tools take.
 */
export async function pageContext(user: User, page: string | null | undefined): Promise<string> {
  const target = pageTarget(page);
  if (!target) return "";
  const brief = (leadId: string | null | undefined, contactId: string | null | undefined) =>
    leadId ? `use lead_brief with "${leadId}"` : contactId ? `use lead_brief with "${contactId}" (the customer's id)` : "";
  try {
    switch (target.kind) {
      case "lead":
      case "contact":
        return pageHint(page);
      case "quote": {
        if (!(await canAccessQuote(user, target.id))) return "";
        const q = await prisma.quote.findUnique({ where: { id: target.id }, select: { number: true, leadId: true, contactId: true } });
        if (!q) return "";
        return `The person is looking at quote Q-${q.number} — "this", "this quote", "the customer" mean it and its customer (${brief(q.leadId, q.contactId)}).`;
      }
      case "signing": {
        const r = await prisma.signatureRequest.findFirst({ where: { id: target.id, deletedAt: null }, select: { title: true, quoteId: true } });
        if (!r) return "";
        if (r.quoteId && (await canAccessQuote(user, r.quoteId))) {
          const q = await prisma.quote.findUnique({ where: { id: r.quoteId }, select: { number: true, leadId: true, contactId: true } });
          if (q) return `The person is looking at the signing request for quote Q-${q.number} — "this" means it (${brief(q.leadId, q.contactId)}).`;
        }
        return "";
      }
      case "test_drive": {
        const t = await prisma.testDriveBooking.findFirst({
          where: { id: target.id, deletedAt: null, ...(await accessibleTestDriveWhere(user)) },
          select: { reference: true, leadId: true, contactId: true, scheduledStart: true, demoVehicle: { select: { name: true } } },
        });
        if (!t) return "";
        return `The person is looking at test drive ${t.reference} (${when(t.scheduledStart)}${t.demoVehicle ? `, ${t.demoVehicle.name}` : ""}) — "this", "the customer" mean it (${brief(t.leadId, t.contactId)}).`;
      }
      case "vehicle": {
        if (!(await canAccessVehicle(user, target.id))) return "";
        const v = await prisma.vehicle.findUnique({ where: { id: target.id }, select: { model: true, regNumber: true, contactId: true } });
        if (!v) return "";
        return `The person is looking at a customer's vehicle (${v.model}) — "the owner", "the customer" mean its owner (${brief(null, v.contactId)}); for its service, battery, warranty or job cards use vehicles kind customer with search "${v.regNumber ?? v.model}".`;
      }
      case "stock": {
        if (!(await hasAnyPermission(user, "stock.view", "stock.manage"))) return "";
        const u = await prisma.stockUnit.findFirst({ where: { id: target.id, deletedAt: null }, select: { stockNumber: true, status: true, product: { select: { name: true } }, reservedForLeadId: true } });
        if (!u) return "";
        return `The person is looking at stock unit ${u.stockNumber ?? ""} (${u.product.name}, ${u.status}) — use vehicles kind stock with search "${u.stockNumber ?? u.product.name}"${u.reservedForLeadId && (await canAccessLead(user, u.reservedForLeadId)) ? `; it is reserved for lead "${u.reservedForLeadId}" (lead_brief)` : ""}.`;
      }
      case "conversation": {
        if (!(await canAccessConversation(user, target.id))) return "";
        const c = await prisma.conversation.findUnique({ where: { id: target.id }, select: { channel: true, leadId: true, contactId: true } });
        if (!c || (!c.leadId && !c.contactId)) return "";
        return `The person has a ${c.channel} conversation open in the inbox — "this customer", "reply to them" mean its customer (${brief(c.leadId, c.contactId)}).`;
      }
      case "leads_board":
        return 'The person is on the leads board — "these", "my pipeline" mean the open leads they can see (find_leads, pipeline_summary).';
      case "today":
      case "attention":
      case "home":
        return 'The person is on their dashboard / today list — "these", "what\'s on here" mean what needs their attention (daily_brief).';
      case "calendar":
        return 'The person is looking at the calendar — "today", "this week", "these" mean their activities (find_activities, schedule).';
      case "deliveries":
        return 'The person is on the deliveries board — "these" mean signed deals on their way (deliveries with no stage).';
      case "quotes":
        return 'The person is on the quotes list — "these" mean their quotes (find_quotes).';
      case "test_drives":
        return 'The person is on the test drives page — "these" mean test drives and demo vehicles (schedule, vehicles kind demo).';
      case "inbox":
        return 'The person is in the inbox — "who is waiting" means customers waiting for a reply (daily_brief).';
    }
  } catch (error) {
    await logError("crm-assistant", "page context failed", error instanceof Error ? error.name : "unknown");
  }
  return "";
}

/** The page's history list: this person's last turns, newest first. */
export async function assistantHistory(userId: string, take = 20) {
  return prisma.assistantTurn.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - HISTORY_DAYS * DAY) } },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, question: true, answer: true, source: true, createdAt: true },
  });
}

export type Observation = { tool: string; args: unknown; output: ToolOutput };

/**
 * What a lookup returned, as the model reads it. CUSTOMER-AUTHORED TEXT lives in
 * here — names, web-form notes, WhatsApp and email bodies — and JSON.stringify
 * doesn't escape invisible characters, so an instruction hidden in the TAG block
 * would reach the model while staff looking at the record see nothing. Stripped
 * here, on every observation, before either step sees it.
 */
export function observationText(o: Observation): string {
  // Each STRING VALUE is cleaned before it is serialised — never the finished
  // JSON. Cleaning folds fullwidth forms (NFKC), and a customer's fullwidth
  // ＂ and ＼ would otherwise become real quotes after stringify and forge
  // sibling fields ("status":"won", fake approved answers) inside the results.
  const body = JSON.stringify({ truncated: o.output.truncated, results: cleanDeep(o.output.data) });
  const budget = OBSERVATION_BUDGET[o.tool] ?? OBSERVATION_CHARS;
  return `${o.tool} ${JSON.stringify(cleanDeep(o.args ?? {}))} →\n${body.length > budget ? `${body.slice(0, budget)}…(cut)` : body}`;
}

/** Every string in a value — object KEYS as well as values — cleaned, before it is serialised. */
export function cleanDeep(value: unknown): unknown {
  if (typeof value === "string") return stripInvisible(value);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [stripInvisible(k), cleanDeep(v)]));
  }
  return value;
}
