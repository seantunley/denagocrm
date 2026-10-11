import type { HelpArticle } from "../types";

export const homeArticles: HelpArticle[] = [
  {
    slug: "home-screen",
    title: "Home: what needs you today",
    summary: "The screen you land on — one line about your day, a few numbers, and the deals most worth contacting next.",
    category: "getting-started",
    audience: "everyone",
    keywords: ["home", "home screen", "do next", "start here", "start my day", "overview", "what to do", "landing page"],
    body: [
      { type: "p", text: "**Home** is the first screen after you sign in. It answers one question before any other: what should I do now? It shows as little as it can while doing so. Your charts and the cards you arranged are still there, one click away under **Dashboards**." },
      { type: "h", text: "The summary band" },
      { type: "p", text: "The band at the top greets you and sums up your day in one sentence, for example \"2 follow-ups overdue and 4 deals worth contacting\". A small label above your name sets the tone:" },
      {
        type: "table",
        headers: ["Label", "Meaning"],
        rows: [
          ["All clear", "Nothing needs you right now."],
          ["Worth your time today", "There are deals worth contacting."],
          ["Catch up first", "You have planned work that is past due."],
        ],
      },
      { type: "p", text: "**Start my day** opens the Today page with the full list. If a sales target is set for the month, a ring shows how far along it is; if not, the band shows what has been sold and offers a link to set a target." },
      { type: "h", text: "The numbers" },
      { type: "p", text: "Below the band are at most five numbers. Each one says what it is measured against, and each is a link to the records behind it." },
      {
        type: "table",
        headers: ["Number", "What it counts"],
        rows: [
          ["Sold this month", "Deals won this month, against your target or against the same days last month."],
          ["Open pipeline", "The value of open deals, and how many there are."],
          ["New leads this month", "New leads, compared with the same days last month."],
          ["Overdue for you", "Your own planned work that is past due."],
          ["Out for signature", "Quotes waiting on a customer to sign."],
        ],
      },
      { type: "callout", tone: "info", text: "You only see numbers for things you are allowed to open. A number that is not yours to see is left out, not shown as zero." },
      { type: "h", text: "Do next" },
      { type: "p", text: "**Do next** lists up to six deals most worth contacting, best first. The top one is marked **Start here**. Every deal shows why it is on the list and a button for the suggested action. A link at the foot opens the full list on the Today page." },
      { type: "p", text: "If you can see everyone's deals, switch between **Mine** and **Everyone** at the top of the list. When no deal has a reason to be contacted today, the list says **You're clear.**" },
      { type: "h", text: "Beside the list" },
      {
        type: "list",
        items: [
          "**Today** — your agenda for the day, with a link to the Calendar.",
          "**Waiting on others** — how many quotes are out for signature.",
          "**Pipeline** — the shape of the pipeline by stage, with a link to the board.",
        ],
      },
      { type: "h", text: "Follow-up prompts and the daily brief" },
      { type: "p", text: "If you have overdue follow-ups, prompts for them appear above everything else so they cannot be missed. At the foot of the page, **DAX's brief for today** folds open when the assistant has more to tell you, and **Dashboards** takes you to your charts and cards." },
      { type: "callout", tone: "tip", text: "Home is the same for everyone and is not arranged by hand. To build a screen of your own, use Dashboards — see **Your dashboards: how they are put together**." },
    ],
  },
];
