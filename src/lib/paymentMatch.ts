/**
 * PROOF OF PAYMENT → WHICH INVOICE (Sean, 2026-11-02: "Lets do 1, 2 and 3" — round 2, item 3).
 *
 * A proof of payment arrives with no quote named. Which invoiced quote with money owing is it for? Pure, so it can
 * be tested without a database: the lookup (assistantPaymentMatch.ts) hands it each candidate with the LEDGER's own
 * figures — the balance owing (accountStatement.outstandingCents, the read side of quoteLedger's rule) and the
 * deposit on the quote's terms (pricing.quotePricing) — and this only compares.
 *
 * Evidence, strongest first: the bank reference names the quote or invoice; the amount is exactly the deposit due
 * or the balance owing; the payer's name is the customer's. A candidate the amount would overpay is never offered —
 * the ledger would refuse it.
 *
 * ONE CLEAR MATCH only when the top candidate has a reference or amount match AND strictly more kinds of evidence
 * than every other candidate (its kinds a proper superset of each other's). Two quotes owing the same R25 000, or the
 * amount pointing at one and the reference at another, are offered as choices — never guessed between.
 */

export type PaymentCandidate = {
  quoteNumber: number;
  invoiceNumber: number | null;
  /** The customer's first name, surname and company, as stored. */
  customerNames: (string | null | undefined)[];
  /** What is still owed: total − deposit recorded − live payments. */
  owingCents: number;
  /** The deposit on the quote's terms while no money is in yet; 0 once anything is recorded. */
  depositDueCents: number;
};

export type PaymentClue = { amountCents: number; reference?: string | null; payer?: string | null };
export type MatchReason = "reference" | "deposit" | "balance" | "payer";
export type PaymentMatch<C> = { candidate: C; reasons: MatchReason[] };

const WEIGHT: Record<MatchReason, number> = { reference: 4, deposit: 2, balance: 2, payer: 1 };
/** Deposit and balance are the same kind of evidence: the amount. */
const kind = (reason: MatchReason) => (reason === "deposit" || reason === "balance" ? "amount" : reason);
/** Words on a bank line that name nobody. */
const NOISE = new Set(["mr", "mrs", "ms", "miss", "dr", "the", "and", "pty", "ltd", "inc", "trust", "trading", "payment", "deposit", "eft"]);

function words(text: string | null | undefined): string[] {
  return (text ?? "").toLowerCase().split(/[^a-zÀ-ɏ]+/).filter((w) => w.length >= 3 && !NOISE.has(w));
}

/** The numbers a reference names: "INV-001030" → invoice 1030; "Q1030" → quote 1030; a bare "1030" → either. */
function referenceNames(reference: string): { quote: Set<number>; invoice: Set<number> } {
  const quote = new Set<number>();
  const invoice = new Set<number>();
  for (const m of reference.matchAll(/(inv|q)?[\s#:-]*(\d+)/gi)) {
    const n = Number(m[2]);
    if (!n) continue;
    const prefix = m[1]?.toLowerCase();
    if (prefix !== "inv") quote.add(n);
    if (prefix !== "q") invoice.add(n);
  }
  return { quote, invoice };
}

export function rankPaymentMatches<C extends PaymentCandidate>(
  candidates: C[],
  clue: PaymentClue,
): { matches: PaymentMatch<C>[]; clear: PaymentMatch<C> | null } {
  const named = clue.reference ? referenceNames(clue.reference) : null;
  const payer = new Set(words(clue.payer));
  const matches: PaymentMatch<C>[] = [];
  for (const candidate of candidates) {
    if (candidate.owingCents <= 0 || clue.amountCents > candidate.owingCents) continue;
    const reasons: MatchReason[] = [];
    if (named && (named.quote.has(candidate.quoteNumber) || (candidate.invoiceNumber !== null && named.invoice.has(candidate.invoiceNumber)))) reasons.push("reference");
    if (candidate.depositDueCents > 0 && clue.amountCents === candidate.depositDueCents) reasons.push("deposit");
    else if (clue.amountCents === candidate.owingCents) reasons.push("balance");
    if (payer.size && candidate.customerNames.some((name) => words(name).some((w) => payer.has(w)))) reasons.push("payer");
    if (reasons.length) matches.push({ candidate, reasons });
  }
  const score = (m: PaymentMatch<C>) => m.reasons.reduce((sum, r) => sum + WEIGHT[r], 0);
  matches.sort((a, b) => score(b) - score(a) || b.candidate.quoteNumber - a.candidate.quoteNumber);

  const [top, ...rest] = matches;
  if (!top) return { matches, clear: null };
  const topKinds = new Set(top.reasons.map(kind));
  const strong = topKinds.has("reference") || topKinds.has("amount");
  const dominates = rest.every((other) => {
    const kinds = new Set(other.reasons.map(kind));
    return kinds.size < topKinds.size && [...kinds].every((k) => topKinds.has(k));
  });
  return { matches, clear: strong && dominates ? top : null };
}
