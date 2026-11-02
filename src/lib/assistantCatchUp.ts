import { johannesburgDateKey } from "./activityDay";
import { stamp } from "./assistantWhy";

/**
 * "Catch me up" — the PURE half. assistantCatchUpLookup.ts reads the rows the person may see; the tests drive this.
 *
 * What changed on the person's OWN deals since they last asked DAX anything (in the CRM or on WhatsApp): new
 * customer messages, quotes opened (first time or again), signed, declined or sent back for changes, stage moves
 * and wins or losses someone ELSE made, new leads for them — plus, as things stand now, their overdue and
 * due-today tasks. All read straight from the records, newest first, each with its time and link. Nothing guessed.
 */

/** A catch-up never reaches further back than this. */
export const CATCH_UP_MAX_DAYS = 7;
/** No earlier question to measure from: the last day. */
export const CATCH_UP_DEFAULT_HOURS = 24;
/** Enough to read on a phone — and to stay inside one lookup's share of the prompt; the rest is counted. */
export const CATCH_UP_MAX_ITEMS = 15;

const DAY_MS = 86_400_000;
const startOfDay = (key: string) => new Date(`${key}T00:00:00+02:00`);

/**
 * From when. Their last question to DAX, at most CATCH_UP_MAX_DAYS back; the last CATCH_UP_DEFAULT_HOURS when there
 * is none. A day they name ("anything new since Friday") replaces it, within the same limit. `basis` says which, so
 * the answer can say "since…" truthfully.
 */
export function catchUpSince(now: Date, lastTurnAt: Date | null, sinceDay?: string | null): { since: Date; basis: string } {
  const floor = new Date(now.getTime() - CATCH_UP_MAX_DAYS * DAY_MS);
  const asked = sinceDay ? startOfDay(sinceDay) : null;
  if (asked && !Number.isNaN(asked.getTime())) {
    if (asked.getTime() < floor.getTime()) return { since: floor, basis: `${CATCH_UP_MAX_DAYS} days ago — the furthest back a catch-up looks (they asked from ${sinceDay})` };
    if (asked.getTime() > now.getTime()) return { since: startOfDay(johannesburgDateKey(now)), basis: "the start of today" };
    return { since: asked, basis: `the start of ${sinceDay}, as they asked` };
  }
  if (!lastTurnAt) return { since: new Date(now.getTime() - CATCH_UP_DEFAULT_HOURS * 3_600_000), basis: "the last 24 hours — they have no earlier question to DAX" };
  if (lastTurnAt.getTime() < floor.getTime()) {
    return { since: floor, basis: `${CATCH_UP_MAX_DAYS} days ago — their last question to DAX was longer ago, and a catch-up looks back at most ${CATCH_UP_MAX_DAYS} days` };
  }
  return { since: lastTurnAt, basis: "their last question to DAX" };
}

export type CatchUpItem = { at: Date; type: "message" | "quote" | "deal" | "new_lead"; what: string; link: string; [fact: string]: unknown };
export type ListedItem = { when: string; type: CatchUpItem["type"]; what: string; link: string; [fact: string]: unknown };

/** Newest first, at most `max`, each time in South African time; `cut` is how many more there were. */
export function newestFirst(items: readonly CatchUpItem[], max = CATCH_UP_MAX_ITEMS): { items: ListedItem[]; cut: number } {
  const sorted = [...items].sort((a, b) => b.at.getTime() - a.at.getTime());
  return {
    items: sorted.slice(0, max).map(({ at, ...rest }) => ({ when: stamp(at), ...rest })),
    cut: Math.max(0, sorted.length - max),
  };
}

export type InboundMessage = { at: Date; channel: string; text: string | null; customerKey: string; customer: string; link: string; leadId: string | null; contactId: string | null };
export type OutboundMessage = { at: Date; leadId: string | null; contactId: string | null; bot: boolean };

/**
 * New messages, one item per customer: how many, on which channels, the latest one's words — and whether anyone
 * has answered since (a person, or only the chatbot), so "who is waiting" needs no second question.
 */
export function messagesByCustomer(inbound: readonly InboundMessage[], outbound: readonly OutboundMessage[]): CatchUpItem[] {
  const byCustomer = new Map<string, InboundMessage[]>();
  for (const m of inbound) byCustomer.set(m.customerKey, [...(byCustomer.get(m.customerKey) ?? []), m]);
  return [...byCustomer.values()].map((messages) => {
    const newest = messages.reduce((a, m) => (m.at.getTime() > a.at.getTime() ? m : a));
    const after = outbound
      .filter((o) => o.at.getTime() > newest.at.getTime() && ((newest.contactId && o.contactId === newest.contactId) || (newest.leadId && o.leadId === newest.leadId)))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const person = after.find((o) => !o.bot);
    const bot = after.find((o) => o.bot);
    const channels = [...new Set(messages.map((m) => m.channel))].join(", ");
    return {
      at: newest.at,
      type: "message",
      what: `${newest.customer} wrote ${messages.length === 1 ? "a message" : `${messages.length} messages`} (${channels})`,
      customer: newest.customer,
      latest: newest.text,
      replied: person ? `yes — ${stamp(person.at)}` : bot ? `only the chatbot — ${stamp(bot.at)}` : "not yet",
      link: newest.link,
    };
  });
}

export type QuoteNews = {
  id: string;
  number: number;
  customer: string;
  viewedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  changeRequestedAt: Date | null;
  changeRequestNote: string | null;
  /** The customer coming BACK to it in the window — every sitting after their first ever (signing/viewAnalytics). */
  revisits: readonly Date[];
};

const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/**
 * What the customer did with one quote in the window — the moments proactive DAX alerts on (opened, opened again,
 * signed) read from the same records, plus a decline or a request for changes. Opening a quote already signed again
 * is no news (notifyQuoteActivity's rule).
 */
export function quoteNews(q: QuoteNews, since: Date): CatchUpItem[] {
  const n = `Q-${q.number}`;
  const link = `/quotes/${q.id}`;
  const inWindow = (d: Date | null): d is Date => d !== null && d.getTime() > since.getTime();
  const item = (at: Date, what: string, extra: Record<string, unknown> = {}): CatchUpItem => ({ at, type: "quote", what, quote: n, customer: q.customer, ...extra, link });
  const items: CatchUpItem[] = [];
  if (inWindow(q.viewedAt)) items.push(item(q.viewedAt, `${q.customer} opened ${n} for the first time`));
  const again = q.signedAt ? [] : q.revisits.filter(inWindow);
  if (again.length) {
    const last = again.reduce((a, d) => (d.getTime() > a.getTime() ? d : a));
    items.push(item(last, `${q.customer} opened ${n} again${again.length > 1 ? ` (${again.length} times)` : ""}`));
  }
  if (inWindow(q.signedAt)) items.push(item(q.signedAt, `${q.customer} signed ${n}`));
  if (inWindow(q.declinedAt)) items.push(item(q.declinedAt, `${q.customer} declined ${n}`, q.declineReason ? { reason: clip(q.declineReason, 200) } : {}));
  if (inWindow(q.changeRequestedAt)) items.push(item(q.changeRequestedAt, `${q.customer} asked for changes to ${n}`, q.changeRequestNote ? { request: clip(q.changeRequestNote, 200) } : {}));
  return items;
}

/** Their tasks as they stand now: overdue (from an earlier day) first, oldest first, then today's by time. */
export function taskList(tasks: readonly { summary: string; type: string; dueDate: Date; customer: string | null; link: string }[], now: Date) {
  const today = startOfDay(johannesburgDateKey(now)).getTime();
  return [...tasks]
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
    .map((t) => ({ summary: t.summary, type: t.type, due: stamp(t.dueDate), ...(t.dueDate.getTime() < today ? { overdue: true } : {}), ...(t.customer ? { customer: t.customer } : {}), link: t.link }));
}

/** Sent with the items, so the rule sits next to the data it governs (as WHY_LEGEND does). */
export const CATCH_UP_LEGEND =
  "What changed on this person's OWN deals (`mine`) since `since` — `sinceBasis` says why from then. `items`, newest first: new customer messages (`replied` says whether anyone has answered since), quotes opened for the first time or again, signed, declined or sent back for changes, stage moves, wins and losses, deals parked or reactivated and deliveries booked or moved — made by someone else (`by`) — and new leads for them. `tasks` is how things stand NOW (`overdue` and `dueToday` are the full counts; `list` the first few). " +
  "Open with \"Since <since in plain words>:\" (\"since yesterday at 17:40\"), then the items newest first, each with its link; a customer still waiting on a reply is worth saying so. If `items` is empty, say plainly that nothing has changed since then — then the tasks. Never add anything that is not listed.";
