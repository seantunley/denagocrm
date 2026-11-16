import type { FinanceStatus } from "./dealFinanceRules";

/** DAX and finance — the PURE half (the rule the planner reads and the card's shape); assistantFinance.ts does the reading. */

export const FINANCE_RULE =
  '- finance: a deal financed through a finance house — {"type":"finance","leadId":"<id>","status":"docs_outstanding|submitted|approved|declined|paid_out|withdrawn","financeHouse":"<only when they name one>","reference":"<their application number, only when given>","note":"<what the finance house said, in their words — optional>"}. ' +
  'Propose it when they say where a deal\'s finance stands ("WesBank approved Jody", "sent Grant\'s application in", "finance declined"). Run the finance lookup first to see the deal\'s finance as it is. ' +
  "The status is what they said happened; never move it further than that. The card shows it before Confirm; nobody is contacted. A financed deal's delivery can't be booked until it is approved or paid out — say so if they ask to book one.";

export type FinanceCard = {
  id: string; kind: "finance"; leadId: string; leadLabel: string; title: string; reason?: string;
  vendorId: string; status: FinanceStatus; reference: string | null; note: string | null;
  /** What the card SHOWED: the finance's status and when it last moved (null: not financed yet). Confirm refuses if either changed. */
  wasStatus: string | null; wasStatusAt: string | null;
  detail: string;
};
