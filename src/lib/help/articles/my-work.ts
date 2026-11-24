import type { HelpArticle } from "../types";

export const myWorkArticles: HelpArticle[] = [
  {
    slug: "my-work",
    title: "My Work: everything waiting on you",
    summary: "One list of what is on you right now, from every part of the CRM, sorted by when it is due.",
    category: "getting-started",
    audience: "everyone",
    keywords: ["my work", "my tasks", "to do", "queue", "assigned to me", "what is on me", "overdue", "waiting"],
    body: [
      { type: "p", text: "**My Work** gathers everything that is waiting on you into one list, so you don't have to check each page. Every row opens the record it is about. Do the work there — log the call, move the job card, approve the document — and the row leaves the list on its own." },
      { type: "h", text: "What appears on it" },
      {
        type: "table",
        headers: ["Area", "What shows"],
        rows: [
          ["Sales", "Your deals most worth contacting today (the same as **Today → Mine**), your planned calls, meetings and tasks for the next seven days and any that are overdue, and quotes you sent that the customer has not signed yet."],
          ["Deliveries", "Signed deals of yours that have not been handed over yet."],
          ["Workshop", "Open job cards where you are the technician."],
          ["Support", "Open help desk cases assigned to you."],
          ["Approvals", "Documents waiting for your approval."],
        ],
      },
      { type: "callout", tone: "info", text: "You only see what you are allowed to open on its own page. An area your role cannot see, or a part of the CRM your workspace has switched off, is simply left out." },
      { type: "h", text: "How it is sorted" },
      {
        type: "list",
        items: [
          "**Overdue** — past its date. A task with a time is overdue once that time has passed; an all-day one once its day has.",
          "**Today** — due today.",
          "**Coming up** — due in the days ahead.",
          "**No date** — yours, without a due date, such as a case or a job card.",
          "**Waiting on someone else** — still yours, but the next move is the customer's or a signer's.",
        ],
      },
      { type: "p", text: "Urgent job cards and cases go to the top of their section. Use the buttons at the top to show one area at a time." },
      { type: "p", text: "Rows marked **Suggested** were worked out from the record — for example a deal worth contacting — rather than set as a task by someone. They go away by themselves once the record changes." },
      { type: "h", text: "Later: snooze or dismiss" },
      {
        type: "list",
        items: [
          "**Snooze** takes a row off your list until tomorrow, for 3 days or for a week. Nothing on the record changes — a snoozed task is still due — and it comes back on the day you picked. **Snoozed** shows what you have snoozed, with **Bring back now**.",
          "**Dismiss** is for suggestions only: \"not this one\". It comes back if its reason changes, or after 30 days. A task can't be dismissed — it leaves the list when it is done on its record.",
        ],
      },
      { type: "callout", tone: "info", text: "Snoozing and dismissing only change your own list. Nobody else's list, and no record, is affected." },
      { type: "h", text: "Stuck deals" },
      { type: "p", text: "Your open deals that have sat in their stage past its time limit appear as suggestions, most stuck first, with what is holding each up and an **Evidence** link to the record and date the reason was read from. The time limit is each stage's own **stale after** days in the pipeline settings (14 when a stage has none). A deal parked in Nurture is not stuck. A deal a week or more past its limit is marked urgent. Dismissing one holds until its reason changes — another day stuck is not a new reason." },
      { type: "h", text: "Done today and Team" },
      { type: "p", text: "**Done today** lists what you finished today: tasks marked done, cases closed and job cards completed. Workspace owners also see **Team**: for each person, how many planned activities are overdue and due today, and how many open cases and job cards they have — counts only. Below it, **How suggestions land** shows how often people dismissed or snoozed each kind of item over the last 30 days; many dismissals of one kind means its rule needs a look." },
      { type: "callout", tone: "tip", text: "My Work is a module. A workspace owner can ask for it to be switched on; while it is off, the page and its menu link are hidden." },
    ],
  },
];
