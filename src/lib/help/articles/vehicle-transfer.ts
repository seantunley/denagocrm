import type { HelpArticle } from "../types";

export const vehicleTransferArticles: HelpArticle[] = [
  {
    slug: "vehicle-transfer",
    title: "Transferring a vehicle (and its warranty) to a new owner",
    summary: "Move a vehicle to its new owner with a record of who owned it when — its history and warranty stay with it.",
    category: "workshop",
    audience: "everyone",
    keywords: ["transfer", "new owner", "sold", "change owner", "ownership", "previous owner", "warranty transfer", "transfer certificate", "trade in", "inherited"],
    body: [
      { type: "p", text: "When a vehicle changes hands, transfer it rather than editing its customer. The vehicle keeps everything — its services, warranty claims, job cards, battery checks and documents — and you keep a permanent record of who owned it when." },
      { type: "h", text: "Transfer a vehicle" },
      {
        type: "steps",
        items: [
          "Open the vehicle and find **Ownership**. Click **Transfer to new owner**.",
          "Choose the new owner from your contacts, or choose **A new contact** and type their details.",
          "Set the **Transfer date** (today or earlier, never before the current owner took over) and the **Reason**: sold privately, traded in, inherited, company change, correction or other.",
          "Optionally add the **odometer** at handover, a proof document already on the vehicle, and a note.",
          "Click **Transfer**.",
        ],
      },
      { type: "p", text: "The dialog shows how much warranty cover is left. The warranty's dates never change on a transfer." },
      { type: "callout", tone: "info", text: "**Edit** can no longer change a vehicle's owner. If the owner was simply entered wrongly, transfer it with the reason **Correction** — the record shows it was a correction, and the warranty stays exactly as it was." },
      { type: "h", text: "The warranty" },
      { type: "p", text: "The workspace owner decides, on **Warranty → Warranty when a vehicle changes hands**, whether the warranty goes with the vehicle: **Yes** (the default), **No**, or **Needs approval** — then someone with warranty rights approves or declines each transfer on the vehicle's Ownership panel. A warranty claim can't be logged for an owner the warranty doesn't cover." },
      { type: "h", text: "After the transfer" },
      {
        type: "list",
        items: [
          "**Ownership** lists every owner with their dates and the reason, newest first. The old owner's contact page lists the vehicle under **Previously owned**.",
          "**Transfer certificate** prints a certificate for the new owner: the vehicle, VIN, transfer date, odometer and the warranty's expiry and cover remaining, under your logo.",
          "**Send welcome** sends the new owner your “Welcome to a vehicle's new owner” message (by email, or SMS if they can only be texted). Nothing is sent until you press Send; edit its wording in **Settings → Email templates**.",
          "Service-due and recall reminders go to the new owner. Any reminder still waiting to go to the old owner about this vehicle is cancelled (one already being sent at that moment can't be recalled). Their other messages, like a birthday greeting, carry on.",
          "Each warranty claim still names the person who made it.",
          "**Undo the last transfer** gives the vehicle back to its previous owner — until the new owner has a warranty claim, job card or service on it. Then it tells you why it can't, and you transfer it back with the reason Correction.",
        ],
      },
      { type: "h", text: "What each person sees in the customer portal" },
      {
        type: "table",
        headers: ["Who", "What they see"],
        rows: [
          ["The new owner", "The vehicle, its warranty, their own services and claims, and a short list of earlier services (date and odometer only) — never the previous owner's name, details, invoices, prices, or anything typed on their services."],
          ["The previous owner", "The vehicle is gone from their portal from the transfer. Their own invoices and documents, and the vehicle's paperwork from their time, stay theirs."],
          ["Your team", "Everything, with the owner at the time named on each service, job card, claim and document."],
        ],
      },
      { type: "p", text: "A document added to the vehicle before the transfer stays with the owner of that time. To let one pass to the next owner — the service book, the warranty certificate — click **Stays with the vehicle?** next to it in the vehicle's Documents." },
      { type: "callout", tone: "tip", text: "DAX can do this too: tell it “Thandi sold her Nomad to Sipho on the 3rd” and it proposes the transfer on a card for you to confirm. Ask it “who owned this cart before?” to see the ownership history." },
      { type: "p", text: "Transferring needs the **Transfer vehicles** permission, which CRM administrators, workshop managers and sales managers have by default (the workspace owner always can)." },
    ],
  },
];
