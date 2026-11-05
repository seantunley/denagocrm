import { normalizeRoutePattern, routeMatches } from "./flowRouteRule";

/**
 * QR CODES THAT START A CHATBOT FLOW (Sean, 2026-11-02: "a QR code that, when scanned by a customer, will WhatsApp them a
 * brochure, price list and contact details immediately").
 *
 * A QR opens WhatsApp to the business number with a message already typed. The customer taps Send — WhatsApp never
 * lets a business message first — and that message is a WhatsApp KEYWORD ROUTE to the flow that sends the pack
 * (its "Send a document" and "Send contact card" steps). So a QR code is nothing but a named route: the route does the
 * routing; this keeps the name, the message and the link. Stored per workspace (a setting), no table of its own.
 */
export const FLOW_QR_KEY = "FLOW_QR_CODES";

export type FlowQrCode = { routeId: string; name: string; message: string };

/** The saved list — anything malformed dropped, never thrown on. */
export function parseQrCodes(raw: string | null | undefined): FlowQrCode[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list)
      ? list.filter((q): q is FlowQrCode => q && typeof q.routeId === "string" && typeof q.name === "string" && typeof q.message === "string")
      : [];
  } catch {
    return [];
  }
}

/** What the QR encodes: WhatsApp's own click-to-chat link, with the message typed in. */
export function qrLink(businessDigits: string, message: string): string {
  return `https://wa.me/${businessDigits.replace(/\D/g, "")}?text=${encodeURIComponent(message.trim())}`;
}

/** The source a NEW customer is given when they arrive through this QR — so the count per QR is a count of people. */
export const qrSource = (name: string) => `QR code — ${name.trim()}`.slice(0, 120);

/** What the customers a QR brought in went on to do (lib/flowQrOutcomes). `wonCents` null = not shown to this viewer. */
export type QrOutcomes = { people: number; quotes: number; won: number; wonCents: number | null };

/**
 * QR → SALE, in one line (Sean, 2026-11-04): "Showroom Poster → 3 quotes → 1 sale". The sale's value is shown only to
 * someone who may see sales figures (`wonCents` is null otherwise). `money` formats cents (lib/format.formatZAR).
 */
export function qrOutcomeLine(o: QrOutcomes, money: (cents: number) => string): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  return [
    n(o.people, "new customer", "new customers"),
    n(o.quotes, "quote sent", "quotes sent"),
    `${n(o.won, "sale", "sales")}${o.won && o.wonCents !== null ? ` (${money(o.wonCents)})` : ""}`,
  ].join(" → ");
}

/**
 * Quotes sent, counted per FAMILY (an original and its revisions, which may chain): a family counts once if any
 * version of it was sent or accepted — so a declined original with a sent revision is one quote sent, not zero.
 * A version whose parent isn't in `rows` (deleted) heads its own family.
 */
export function sentQuoteFamilies(rows: readonly { id: string; revisionOfId: string | null; status: string }[]): number {
  const parent = new Map(rows.map((q) => [q.id, q.revisionOfId]));
  const rootOf = (id: string) => {
    // ponytail: 50 hops caps a pathological chain, as lib/quoteVersions does.
    for (let hop = 0; hop < 50; hop++) {
      const up = parent.get(id);
      if (!up || !parent.has(up)) return id;
      id = up;
    }
    return id;
  };
  return new Set(rows.filter((q) => q.status === "sent" || q.status === "accepted").map((q) => rootOf(q.id))).size;
}

/** The route pattern for a QR's message — exactly what addFlowRoute would store. */
export const qrPattern = (message: string) => normalizeRoutePattern(message);

/** Which QR (if any) this inbound text came from: the same match the route itself makes. */
export function matchQrCode(codes: readonly FlowQrCode[], text: string): FlowQrCode | null {
  return codes.find((code) => routeMatches({ kind: "keyword", pattern: qrPattern(code.message) }, { text })) ?? null;
}
