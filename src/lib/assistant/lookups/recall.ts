import "server-only";
import { z } from "zod";
import { prisma } from "../../db";
import { ownedWriteTenantId } from "../../tenantWrite";
import { liveTurnsWhere } from "../../assistantConversation";
import { getAccessibleLeadIds, hasAnyPermission } from "../../permissions";
import { splitListed } from "../../assistantListedRules";
import { recallArgs } from "../../crmAssistantPlan";
import { DAY, HISTORY_DAYS, ToolOutput, User, fuzzy, dateKey, clip } from "../lookupKit";
import { when } from "./schedule";

/** The asker's own earlier conversations — never anyone else's. */
/**
 * This person's earlier conversations (Hermes' session search): the turns that
 * match the most of the query's words, best first, each WITH the turns either
 * side of it that day — a decision is usually the answer to the question
 * before — so the answer step can say what was decided, not just quote a line.
 *
 * Found by meaning without embeddings: the planner's other wordings
 * (alternatives), the tags each answer wrote about itself, Postgres full-text
 * search (stems: "orders" finds "order"), trigram similarity for typos, and —
 * strongest — the records a turn looked at, so "what did we say about Anna?"
 * finds the turn that read her lead even if it never said her name.
 */
export async function recall(user: User, raw: z.infer<typeof recallArgs>): Promise<ToolOutput> {
  const { query, alternatives = [], lead } = recallArgs.parse(raw);
  const words = [...new Set([query, ...alternatives].flatMap(recallWords))].slice(0, RECALL_WORDS);
  const refs = lead ? await recallLeadRefs(user, lead) : [];
  // websearch_to_tsquery never throws on odd input; "or" between words makes
  // any one of them enough. A leading "-" would mean NOT there, so it goes.
  const search = words.map((w) => w.replace(/^[-']+/, "")).filter(Boolean).join(" or ");
  const since = new Date(Date.now() - HISTORY_DAYS * DAY);
  // Raw SQL for full-text and trigram matching, which Prisma's filters can't
  // express. It runs on the tenant-scoped client (RLS applies), and still names
  // the tenant and the asker itself: never anyone else's conversations.
  // ponytail: the match conditions run over one person's 30 days of turns (the
  // tenant/user/createdAt index narrows to those); fine at hundreds of turns.
  const candidates = await prisma.$queryRaw<RecallRow[]>`
    SELECT "id", "question", "answer", "createdAt", "state", "refs", "tags",
           ts_rank(to_tsvector('english', "question" || ' ' || "answer"), websearch_to_tsquery('english', ${search}))::float8 AS "ftsRank",
           (SELECT coalesce(max(word_similarity(w, "question" || ' ' || "answer")), 0) FROM unnest(${words}::text[]) AS w)::float8 AS "similarity"
      FROM "AssistantTurn"
     WHERE "tenantId" = ${ownedWriteTenantId()}
       AND "userId" = ${user.id}
       AND "createdAt" >= ${since}
       -- Never from a conversation its person deleted (assistantConversation.liveTurnsWhere, as SQL).
       AND NOT EXISTS (SELECT 1 FROM "AssistantConversation" c WHERE c."id" = "AssistantTurn"."conversationId" AND c."deletedAt" IS NOT NULL)
       AND (
         (cardinality(${words}::text[]) = 0 AND cardinality(${refs}::text[]) = 0)
         OR "refs" && ${refs}::text[]
         OR to_tsvector('english', "question" || ' ' || "answer") @@ websearch_to_tsquery('english', ${search})
         OR to_tsvector('english', array_to_string("tags", ' ')) @@ websearch_to_tsquery('english', ${search})
         OR EXISTS (SELECT 1 FROM unnest(${words}::text[]) AS w WHERE w <% ("question" || ' ' || "answer"))
       )
     ORDER BY "createdAt" DESC
     LIMIT ${RECALL_CANDIDATES}`;
  const best = rankRecall(candidates, words, refs).slice(0, RECALL_MATCHES);
  if (!best.length) return { truncated: false, rows: [], data: [{ note: "Nothing in this person's last 30 days of conversations matches." }] };
  // The turn before and after each match, same South African day — never one from a deleted conversation.
  const live = await liveTurnsWhere(ownedWriteTenantId(), user.id);
  const around = await Promise.all(
    best.map((t) => {
      const day = dateKey(t.createdAt);
      const dayStart = new Date(`${day}T00:00:00+02:00`);
      return Promise.all([
        prisma.assistantTurn.findFirst({
          where: { userId: user.id, tenantId: ownedWriteTenantId(), createdAt: { gte: dayStart, lt: t.createdAt }, AND: [live] },
          orderBy: { createdAt: "desc" },
          select: { question: true, answer: true },
        }),
        prisma.assistantTurn.findFirst({
          where: { userId: user.id, tenantId: ownedWriteTenantId(), createdAt: { gt: t.createdAt, lt: new Date(dayStart.getTime() + DAY) }, AND: [live] },
          orderBy: { createdAt: "asc" },
          select: { question: true, answer: true },
        }),
      ]);
    }),
  );
  const short = (t: { question: string; answer: string } | null) => (t ? { question: clip(t.question, 200), answer: clip(t.answer, 300) } : undefined);
  return {
    truncated: candidates.length === RECALL_CANDIDATES,
    rows: [],
    data: best.map((t, i) => ({
      when: when(t.createdAt),
      before: short(around[i][0]),
      question: t.question,
      answer: clip(t.answer, 700),
      // What that conversation had decided and left open, in its own words.
      // Never its list of records (assistantListedRules): that is for the next question only, checked again then.
      ...(splitListed(t.state).rest ? { workingMemory: splitListed(t.state).rest } : {}),
      after: short(around[i][1]),
    })),
  };
}

export const RECALL_MATCHES = 4;
export const RECALL_CANDIDATES = 60;
/** The query's words plus the planner's alternatives, together. */
export const RECALL_WORDS = 16;
/** Record links kept per turn — enough for a lead brief and a quote list. */
export const RECALL_REFS = 30;
export type RecallRow = {
  id: string; question: string; answer: string; createdAt: Date;
  state: unknown; refs: string[]; tags: string[]; ftsRank: number; similarity: number;
};

/**
 * "Anna" → the leads (and their customers) this person can see by that name,
 * as refs — lead_brief's own matching and visibility, so recall by customer
 * never reaches a lead they couldn't open.
 */
export async function recallLeadRefs(user: User, needle: string): Promise<string[]> {
  if (!(await hasAnyPermission(user, "leads.view_all", "leads.view_owned"))) return [];
  const ids = await getAccessibleLeadIds(user);
  const leads = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...(ids === null ? {} : { id: { in: ids } }),
      ...(/^c[a-z0-9]{20,}$/i.test(needle)
        ? { OR: [{ id: needle }, { contactId: needle }] }
        : {
            OR: [
              { name: fuzzy(needle) },
              { title: fuzzy(needle) },
              { contact: { OR: [{ firstName: fuzzy(needle) }, { lastName: fuzzy(needle) }, { company: fuzzy(needle) }] } },
            ],
          }),
    },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, contactId: true },
  });
  return leads.flatMap((l) => [`lead:${l.id}`, ...(l.contactId ? [`contact:${l.contactId}`] : [])]);
}

/**
 * The records an answer's lookups returned, as refs ("lead:<id>", "quote:<id>",
 * "contact:<id>"), kept on the turn so recall can find it by customer. Walks
 * the data as returned (like citableLinks): record links, and the leadId /
 * quoteId / contactId a row carries. Only what the person's own lookups saw.
 */
export function turnRefs(data: unknown, cap = RECALL_REFS): string[] {
  const refs = new Set<string>();
  const walk = (value: unknown) => {
    if (refs.size >= cap) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      const link = typeof o.link === "string" ? /^\/(lead|quote|contact)s\/([\w-]{1,64})(?:[/?#]|$)/.exec(o.link) : null;
      if (link) refs.add(`${link[1]}:${link[2]}`);
      for (const kind of ["lead", "quote", "contact"]) {
        const id = o[`${kind}Id`];
        if (typeof id === "string" && /^[\w-]{1,64}$/.test(id)) refs.add(`${kind}:${id}`);
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    }
  };
  walk(data);
  return [...refs].slice(0, cap);
}

export const RECALL_STOP = new Set(["the", "and", "what", "did", "about", "with", "for", "was", "were", "that", "this", "have", "has", "had", "who", "when", "how", "why", "our", "you", "your", "say", "said", "tell", "told", "last", "week", "decide", "decided"]);

/** The words worth searching for: no stop words, no repeats, at most 6. */
export function recallWords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter((w) => w.length > 2 && !RECALL_STOP.has(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * Best first. A turn that looked at the customer asked about beats any wording
 * (it IS about them); then each distinct word found in the text or in the
 * turn's own tags; then Postgres' full-text rank and typo similarity as small
 * nudges. Newest first among equals.
 */
export function rankRecall<
  T extends { question: string; answer: string; createdAt: Date; refs?: string[]; tags?: string[]; ftsRank?: number; similarity?: number },
>(turns: T[], words: string[], refs: string[] = []): T[] {
  const wanted = new Set(refs);
  const score = (t: T) => {
    const text = `${t.question}\n${t.answer}`.toLowerCase();
    const tags = (t.tags ?? []).join("\n").toLowerCase();
    return (
      ((t.refs ?? []).some((r) => wanted.has(r)) ? 1000 : 0) +
      words.filter((w) => text.includes(w)).length * 10 +
      words.filter((w) => tags.includes(w)).length * 10 +
      (Number(t.ftsRank) || 0) * 10 +
      (Number(t.similarity) || 0) * 5
    );
  };
  return turns
    .map((t) => ({ t, n: score(t) }))
    .filter((x) => (!words.length && !refs.length) || x.n > 0)
    .sort((a, b) => b.n - a.n || b.t.createdAt.getTime() - a.t.createdAt.getTime())
    .map((x) => x.t);
}
