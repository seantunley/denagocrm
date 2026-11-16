import type { HelpArticle } from "../types";

export const dealFinanceArticles: HelpArticle[] = [
  {
    slug: "deal-finance",
    title: "Finance through a finance house",
    summary: "Record where each financed deal stands with the finance house, get told when it stalls, and hold delivery until it's approved.",
    category: "sales",
    audience: "everyone",
    keywords: ["finance", "finance house", "bank", "application", "approval", "approved", "declined", "payout", "paid out", "wesbank", "chase"],
    body: [
      { type: "p", text: "When a customer pays through an outside finance house, the deal keeps one finance record: which finance house, their reference, where it stands, and what they said. Every change is dated and in the audit trail, so you can always see how long it has been waiting and on whom." },
      { type: "h", text: "Setting it up (once)" },
      { type: "steps", items: [
        "An owner adds the finance house in **Settings → Suppliers** with **What is it?** set to *Finance*, and its email and phone.",
        "On the finance house's page, under **Documents needed from it**, choose the papers you file from them — for example an approval letter and a payout confirmation. Add those under **Document types** in **Settings** first if you don't have them.",
      ] },
      { type: "h", text: "Recording a deal's finance" },
      { type: "p", text: "Only a deal you put on finance has any of this. A cash deal shows no Finance section, is never chased for finance and is never held back from delivery — there is nothing to withdraw." },
      { type: "steps", items: [
        "On the deal page, under **Suppliers**, add the finance house to the deal. That is what makes it a financed deal — the deal file then asks for its papers.",
        "A **Finance** section appears on the deal page (and a **Finance** tab on the lead). Choose where it stands and their application number. Add what they said if it matters — \"approved subject to a 10% deposit\".",
        "Press **Start finance**.",
        "As things move, change **Where it stands** and press **Save**: *Customer documents outstanding* → *Submitted* → *Approved* (or *Declined*) → *Paid out*. Choose *Withdrawn* if the customer stops financing.",
      ] },
      { type: "callout", tone: "warning", text: "Keep the customer's ID, payslips and bank statements with the finance house — don't upload them to the CRM. File only the approval letter and the payout confirmation on the deal." },
      { type: "h", text: "When it stalls" },
      { type: "p", text: "A deal that sits at **Customer documents outstanding** or **Submitted** for **3 working days** (Monday to Friday) without moving is flagged to chase — the customer for their documents, or the finance house for an answer. You see it:" },
      { type: "list", items: [
        "On the **Attention** list, for open deals. Snooze or dismiss it with a reason like any other warning.",
        "In **DAX's daily brief**, for your own deals — signed ones too, since a quote signed subject to finance marks the deal won.",
        "On the **Finance** page (Sales menu), where every financed deal is listed with its status, and the ones to chase are at the top.",
      ] },
      { type: "p", text: "Moving the status along clears it. A later wait starts the 3 days again. Public holidays are counted as working days." },
      { type: "h", text: "Delivery waits for approval" },
      { type: "p", text: "A financed deal can't have its delivery booked until the finance is **Approved** or **Paid out**. While it is outstanding, submitted or declined, **Schedule delivery** — on the Deliveries board or through DAX — says why and books nothing. If the customer pays another way after a decline, set the finance to *Withdrawn*. The deal page's **Ready to deliver?** shows a **Finance approved** line." },
      { type: "callout", tone: "info", text: "Finance needs the Suppliers module, since the finance house is a supplier. Changing it needs permission to edit leads. The Finance page lists only the deals you may open." },
    ],
  },
];
