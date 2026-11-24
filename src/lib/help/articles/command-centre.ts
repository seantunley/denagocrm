import type { HelpArticle } from "../types";

/**
 * The Command Centre and the other role templates (brief §8: "Document KPI
 * definitions, currency handling and refresh timestamps").
 *
 * Every definition below is the one src/lib/dashboard/commandCentre.ts and
 * commandCards.tsx run. If one of those changes, this article is wrong and must
 * change with it.
 */
export const commandCentreArticles: HelpArticle[] = [
  {
    slug: "command-centre",
    title: "The Command Centre: what every number means",
    summary: "The management dashboard and the Sales, Team and Operations templates — each figure's definition, whose records it counts, how currencies are handled and how fresh it is.",
    category: "getting-started",
    audience: "managers",
    keywords: ["command centre", "command center", "management dashboard", "kpi", "kpis", "template", "dashboard template", "win rate", "on-time delivery", "exceptions", "workload", "forecast vs target", "revenue trend"],
    body: [
      { type: "p", text: "The **Command Centre** is a ready-made dashboard for running the business: what has been won, what is in the pipeline, what is waiting to be delivered, which deals need attention and how the month is tracking against target. Open it from **Command Centre** in the sidebar, or from the dashboard switcher at the top of any dashboard." },
      { type: "h", text: "Ready-made dashboards" },
      { type: "table", headers: ["Dashboard", "For", "Offered to"], rows: [
        ["Command Centre", "Owners", "Anyone who can open Reports"],
        ["Team", "Managers", "Anyone who can open Reports"],
        ["Sales", "Sales people", "Anyone who can see leads"],
        ["Operations", "Deliveries, workshop and help desk", "Anyone who can see deliveries, job cards or help-desk cases"],
      ] },
      { type: "p", text: "They are ordinary dashboards. Until you change one it follows the app, so a card improved in a later release reaches you without you doing anything. Press **Customise** and it becomes your own copy, which you can arrange like any other dashboard. Your other dashboards are not touched." },
      { type: "callout", tone: "info", text: "**Everyone sees their own numbers.** Every figure counts only the records the person looking could open themselves. A sales person who sees only their own deals gets their own totals; an owner gets the whole workspace. A card about something you have no access to — or a module your workspace does not have — simply is not shown." },
      { type: "h", text: "What each number means" },
      { type: "table", headers: ["Figure", "What it counts", "Currency"], rows: [
        ["Won this month", "Deals won since the 1st, dated by the day they were won — the same rule as Reports and Targets. The arrow compares with the same number of days last month.", "Base currency; deals in other currencies are named under the figure, never added in."],
        ["Win rate (90 days)", "Deals won ÷ deals won or lost in the last 90 days. The line under it says how many were decided. Not shown when nothing was decided.", "Not money."],
        ["Open pipeline", "The value of every open deal, and how many there are.", "Base currency, plus the other currencies listed separately."],
        ["Delivered on time (90 days)", "Of the deliveries made in the last 90 days that had a booked date, how many were handed over on or before that day. Deliveries with no booked date are left out. Vehicle and workshop pack only.", "Not money."],
        ["Won value by month", "Deals won in each of the last twelve months. The last bar is this month so far. There is no projection.", "Bars are the base currency; other currencies are totalled under the chart."],
        ["Operations status", "Accepted orders not yet delivered (with their quote totals), how many of those are past their booked delivery date, how many need a deposit with none recorded, open job cards, open help-desk cases and cases nobody owns. Only current quotes count — never a replaced revision.", "Quote totals per currency, using the quote's own price rules (fees, VAT and optional extras included)."],
        ["Management by exception", "The open deals on the Attention list, grouped by why they are there: a customer waiting for a reply, an overdue follow-up, an expiring quote, finance stalled, no next step, too long in a stage, or our follow-up got no reply. A deal with two reasons counts under both.", "Per currency."],
        ["Team workload", "Per person: open deals, deals on the Attention list, and planned follow-ups past their day. Counts only — there is no capacity score.", "Not money."],
        ["Deals most at risk", "The top of the Attention list, in its own order, with each deal's value and main reason.", "Each deal in its own currency."],
        ["Forecast vs target", "This month's sales target beside what is won so far, what is still to win, and the Forecast page's committed and weighted figures for deals expected to close this month.", "Base currency, as Targets and Forecast are; other-currency forecast deals are named."],
      ] },
      { type: "h", text: "How fresh the numbers are" },
      { type: "p", text: "Nothing is stored or cached between visits: every card reads your records when the page opens, and says **as of** the time it did. Reload the page for newer numbers." },
      { type: "h", text: "Getting to the list behind a number" },
      { type: "p", text: "Every figure links to the screen it came from — Reports, Leads, the Attention list, Deliveries, Invoices, Job Cards, Help desk, Targets or Forecast — so you can see the records that make it up." },
      { type: "h", text: "What is deliberately not here" },
      { type: "p", text: "Some management dashboards show a customer-health score, a team \"load %\", revenue by department or a likelihood for each risk. The CRM has no record that measures those, so the Command Centre does not show them rather than show a number nobody can check. Likewise there are no AI-written summaries: every reason on these cards is a fact from your records with a link to it." },
    ],
  },
];
