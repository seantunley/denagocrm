import type { HelpArticle } from "../types";

export const emailSignatureArticles: HelpArticle[] = [
  {
    slug: "email-signatures",
    title: "Email signatures: everyone's signature in one place",
    summary: "Set the signature design, each person's own details, a line per team and a short signature for replies.",
    category: "comms",
    audience: "everyone",
    keywords: ["email signature", "signature", "direct line", "whatsapp", "booking link", "working hours", "photo", "qualifications", "team signature", "reply signature", "lock signature"],
    body: [
      { type: "p", text: "Open **Email signatures** from **Settings → My account**, or from the **Admin** menu if you own the workspace. It shows the signature exactly as it appears on your emails." },
      { type: "callout", tone: "info", text: "Email signatures is a pack. If your workspace doesn't have it, everyone keeps the automatic signature (and your saved design) with no banners. The page is then in **Settings → My account**." },
      { type: "h", text: "Your details" },
      { type: "p", text: "Under **Your details**, add any of these. Each shows on your signature only when it is filled in:" },
      {
        type: "list",
        items: [
          "**Qualifications**: shown small under your name.",
          "**Direct line**, **WhatsApp number** and **Booking link** (a full https:// address): shown as one line of links.",
          "**Working hours**: shown on the next line.",
          "**Photo**: your profile photo. Add it in **Settings → My account** first, then tick **Show the profile photo on the signature**. The photo travels inside the email, so it shows even when the reader's mail app blocks pictures.",
        ],
      },
      { type: "p", text: "Your name, job title and mobile come from **Settings → My account**. If a detail says **set by the workspace owner**, the owner has locked it." },
      { type: "h", text: "For the workspace owner" },
      {
        type: "list",
        items: [
          "**Design**: one design for everyone. Changes show in the preview before you click **Save for everyone**.",
          "**Details staff can't change**: tick a detail to lock it. You then set it for each person under **Your team's details**.",
          "**A line for each team**: shown under the signature of everyone in that team, for example the workshop's hours or the parts number. Someone in two teams gets the first line that is theirs.",
          "**Short signature on replies**: replies get two plain lines (name, title, company, phone and email) instead of the full signature, so long threads don't repeat it. New emails keep the full one.",
          "**Your team's details**: open a person to set any of their details.",
          "**Own HTML**: only the owner can set a custom HTML signature. Anyone who already has one can still clear it.",
        ],
      },
      { type: "p", text: "Marketing banners under the signature are set in **Signature banners**. See the Signature banners article." },
    ],
  },
];
