import type { HelpArticle } from "../types";

export const emailSignatureArticles: HelpArticle[] = [
  {
    slug: "email-signatures",
    title: "Email signatures: everyone's signature in one place",
    summary: "Set the signature design, each person's own details, a line per team and a short signature for replies.",
    category: "comms",
    audience: "everyone",
    keywords: ["email signature", "signature", "direct line", "whatsapp", "booking link", "working hours", "photo", "qualifications", "team signature", "reply signature", "lock signature", "save my contact", "contact card", "vcard", "qr code"],
    body: [
      { type: "p", text: "Open **Email signatures** from **Settings → My account**, or from the **Admin** menu if you own the workspace. It shows the signature exactly as it appears on your emails." },
      { type: "callout", tone: "info", text: "Email signatures is a pack. If your workspace doesn't have it, everyone keeps the automatic signature (and your saved design) with no banners. The page is then in **Settings → My account**." },
      { type: "h", text: "Your signature" },
      { type: "p", text: "Under **Your signature**, type your details on the left. The signature on the right changes as you type, exactly as it will look on your emails. Click **Save my signature** when it looks right. Each detail shows only when it is filled in:" },
      {
        type: "list",
        items: [
          "**Qualifications**: shown small under your name.",
          "**Direct line**, **WhatsApp number** and **Booking link** (a full https:// address): shown as one line of links.",
          "**Working hours**: shown on the next line.",
          "**Your own line**: a short line in the workspace colour, such as “Ask me about the new model”.",
          "**Photo**: your profile photo. Add it in **Settings → My account** first, then tick **Show the profile photo on the signature**. The photo travels inside the email, so it shows even when the reader's mail app blocks pictures.",
        ],
      },
      { type: "p", text: "Above the preview, switch between **Computer**, **Phone** and **Dark mode** to see how it looks in each. **Send myself a test** sends a real email with your saved signature to your own address, so you can check it in Outlook, Gmail or on your phone." },
      { type: "p", text: "To use the same signature in Gmail, Outlook or on your phone, open **Use this signature in Gmail, Outlook or on your phone** under it. **Copy my signature** copies it with the design and your details; **Copy as plain text** is for phone mail apps. Your photo is left out, because it only shows on emails sent from the CRM. If your details or the design change, copy it again." },
      { type: "p", text: "Your name, job title and mobile come from **Settings → My account**. A detail with a padlock is **set by the workspace owner**: you can see it but not change it." },
      { type: "h", text: "For the workspace owner" },
      {
        type: "list",
        items: [
          "**Design**: one design for everyone. Changes show in the preview before you click **Save for everyone**.",
          "**Details staff can't change**: tick a detail to lock it. You then set it for each person under **Your team**.",
          "**A line for each team**: shown under the signature of everyone in that team, for example the workshop's hours or the parts number. Someone in two teams gets the first line that is theirs.",
          "**Short signature on replies**: replies get two plain lines (name, title, company, phone and email) instead of the full signature, so long threads don't repeat it. New emails keep the full one.",
          "**Small print**: a line at the foot of every email (for example your registration and VAT numbers, or a confidentiality notice), and a privacy policy link under everyone's signature. Both are optional. The line is the same one you can set on Signature banners.",
          "**Count clicks on signature links**: off until you tick it. Website, WhatsApp, booking, social and privacy links on emails sent from then on go through the CRM first, and **Signature link clicks** shows which ones customers use, by link and by person. Phone numbers and email addresses aren't counted.",
          "**Save my contact**: off until you choose. **A “Save my contact” link** puts the link under everyone's signature: a customer taps it and their phone offers to add the person to their contacts, with their name, job title, numbers and email and the company's website and address (never the photo). **The link and a QR code** adds a small code beside it for customers reading on a computer, who scan it with their phone. Someone who leaves the workspace stops being handed out, even from old emails.",
          "**Your team**: open a person to edit their signature in the same editor, any detail included. People missing a job title or mobile are listed at the top, because a signature leaves out an empty line. Each person adds those in Settings → My account.",
          "**Workspace design**: the layout everyone's signature uses: Card, Classic, Modern, Compact or Minimal. All of them use your workspace's accent colour (orange if none is set). Check the preview: a logo made for a dark background suits the Card design best.",
          "**Own HTML**: only the owner can set a custom HTML signature. Anyone who already has one can still clear it.",
        ],
      },
      { type: "p", text: "Marketing banners under the signature are set in **Signature banners**. See the Signature banners article." },
    ],
  },
];
