import type { HelpArticle } from "../types";

export const vehicleTransferArticles: HelpArticle[] = [
  {
    slug: "vehicle-transfer",
    title: "Transferring a vehicle (and its warranty) to a new owner",
    summary: "Move a vehicle to its new owner with a record of who owned it when — its history and warranty stay with it.",
    category: "workshop",
    audience: "everyone",
    keywords: ["transfer", "new owner", "sold", "change owner", "ownership", "previous owner", "warranty transfer", "transfer certificate", "trade in", "inherited", "undo transfer"],
    body: [
      { type: "p", text: "When a vehicle changes hands, transfer it rather than editing its customer. The vehicle keeps everything — its services, warranty claims, job cards, battery checks and documents — and you keep a permanent record of who owned it when." },
      { type: "h", text: "Who can transfer" },
      { type: "p", text: "You need permission to transfer vehicles. The workspace owner always can, and the CRM administrator, sales manager and workshop manager roles have it to begin with. An owner can give it to other roles under **Settings → Team & roles**, in the **Workshop** group. Approving a warranty transfer needs permission to manage warranty claims." },
      { type: "h", text: "Transfer a vehicle" },
      {
        type: "steps",
        items: [
          "Open the vehicle and find **Ownership**. Click **Transfer to new owner**. The box at the top shows who owns it now and, if your workspace uses warranties, how much cover is left.",
          "Under **New owner**, choose **An existing contact** and pick them, or **A new contact** and type their name, phone and email. (Only people who may create contacts see **A new contact**.)",
          "Set the **Transfer date**: today or earlier, and not before the current owner took over.",
          "Choose the **Reason**: **Sold privately**, **Traded in**, **Inherited**, **Company change**, **Correction of a data-entry mistake** or **Other**.",
          "If you have them, add the **Odometer at handover**, a **Proof** document already on the vehicle, and a **Note**.",
          "Click **Transfer**.",
        ],
      },
      { type: "p", text: "The warranty's dates never change on a transfer." },
      { type: "callout", tone: "info", text: "**Edit** can't change a vehicle's owner. If the owner was simply entered wrongly, transfer it with the reason **Correction** — the record shows it was a correction, and the warranty stays exactly as it was." },
      { type: "h", text: "The warranty" },
      { type: "p", text: "The workspace owner decides, on the **Warranty** page under **Warranty when a vehicle changes hands**, whether the warranty goes with the vehicle: **Yes** (the starting setting), **No**, or **Needs approval**. With **Needs approval**, someone who may manage warranty claims clicks **Approve** or **Decline** on the vehicle's **Ownership** panel. A warranty claim can't be logged for an owner the warranty doesn't cover." },
      { type: "h", text: "After the transfer" },
      {
        type: "list",
        items: [
          "**Ownership** lists every owner with their dates and the reason, newest first. The old owner's contact page lists the vehicle under **Previously owned**.",
          "**Transfer certificate** prints a certificate for the new owner: the vehicle, VIN, transfer date, odometer and the warranty's expiry and cover remaining, under your logo.",
          "**Send welcome** sends the new owner your welcome message for a vehicle's new owner (by email, or SMS if they can only be texted). Nothing is sent until you press Send. Change its wording under **Settings → Email**, in **Email templates**.",
          "Service-due and recall reminders go to the new owner. Any reminder still waiting to go to the old owner about this vehicle is cancelled (one already being sent at that moment can't be called back). Their other messages, like a birthday greeting, carry on.",
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
      { type: "p", text: "A document added to the vehicle before the transfer stays with the owner of that time. To let one pass to the next owner — the service book, the warranty certificate — click **Stays with the vehicle?** next to it in the vehicle's Documents. It then shows **✓ Stays with the vehicle**." },
      { type: "callout", tone: "tip", text: "The assistant (**Ask the CRM**) can do this too: tell it something like “Jane Smith sold her vehicle to John Brown on the 3rd” and it proposes the transfer on a card for you to confirm. Ask it who owned a vehicle before to see the ownership history." },
      { type: "h", text: "If something goes wrong" },
      {
        type: "table",
        headers: ["Message", "What to do"],
        rows: [
          ["That contact already owns this vehicle.", "Choose the new owner, not the current one."],
          ["The transfer date can't be in the future.", "Use today's date or earlier. Transfer it on the day it happens."],
          ["The transfer date can't be before the current owner took over.", "Check the date against the current owner's start date under **Ownership**."],
          ["You can't create contacts. Choose an existing contact as the new owner.", "Ask someone who can create contacts to add the new owner first."],
          ["That proof document isn't on this vehicle any more. Refresh and choose again.", "Refresh the page and pick the proof again, or leave it out."],
          ["A message saying the new owner already has warranty claims, job cards or services, so the transfer can't be undone", "Transfer it back with the reason **Correction** instead."],
          ["There's no new owner to welcome on this vehicle.", "**Send welcome** only works after a transfer to a new owner."],
          ["A message starting **Not sent:**", "The new owner has opted out of this kind of message; the message says why."],
        ],
      },
      { type: "h", text: "Related guides" },
      {
        type: "list",
        items: [
          "Registering customer vehicles",
          "Battery health and warranty claims",
          "Warranty and recalls",
          "Customer portal access",
        ],
      },
    ],
  },
];
