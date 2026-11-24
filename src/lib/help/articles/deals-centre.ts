import type { HelpArticle } from "../types";

export const dealsCentreArticles: HelpArticle[] = [
  {
    slug: "deals-centre",
    title: "Deals: every deal, what is owed and what is in the way",
    summary: "One list of your quotes as deals — value, money in, money still owed, finance, delivery, and what is stopping each one.",
    category: "sales",
    audience: "everyone",
    keywords: ["deals", "deals centre", "owed", "balance", "outstanding", "blocked", "ready for delivery", "deposit outstanding", "finance pending", "committed", "proposed"],
    body: [
      { type: "p", text: "**Deals** (under Sales) lists every quote you can see as a deal. It is not a separate record: each row is the quote, read with its payments, its allocated stock, its finance and its delivery. Open a row for the full deal page." },
      { type: "h", text: "Views" },
      {
        type: "table",
        headers: ["View", "What it shows"],
        rows: [
          ["Active", "Quotes out with the customer, and accepted deals not delivered yet. Where the list opens."],
          ["Blocked", "Accepted deals that cannot be handed over yet, with what is in the way."],
          ["Accepted", "Accepted quotes not delivered yet."],
          ["Deposit outstanding", "Accepted deals that ask for a deposit that has not come in."],
          ["Finance pending", "Deals financed through an outside finance house that has not paid out yet. Shown when the Finance module is on."],
          ["Ready for delivery", "Accepted, deposit in (or none asked), a unit allocated and through PDI, and finance not holding it."],
          ["Completed", "Delivered deals."],
          ["All", "Every current quote you can see, drafts included."],
        ],
      },
      { type: "h", text: "The money" },
      {
        type: "list",
        items: [
          "**Committed** — accepted quotes: what has been sold.",
          "**Received** — deposits and payments recorded against accepted deals.",
          "**Owed** — what is still due on accepted deals. A quote that is only sent owes nothing yet.",
          "**Proposed** — quotes sent and not accepted yet: on the table, not sold.",
        ],
      },
      { type: "p", text: "Drafts, declined and cancelled quotes count in none of these. Only the current version of a revised quote is counted, so a revision never doubles a deal. Two accepted quotes on one lead are two orders and are shown as two deals." },
      { type: "callout", tone: "info", text: "Amounts in different currencies are never added together: each currency gets its own totals card." },
      { type: "h", text: "In the way" },
      { type: "p", text: "The last column says what is stopping the deal, in order: not accepted yet, deposit not received, finance not approved (which holds delivery), no unit allocated, PDI not passed, delivery not booked. A step that does not apply — a deal that asks for no deposit — is not listed as missing." },
    ],
  },
];
