import type { HelpArticle } from "../types";

export const secureLinkArticles: HelpArticle[] = [
  {
    slug: "email-secure-links",
    title: "Sending a file as a secure link",
    summary: "Send ID copies, bank and finance documents as a link that expires and can be recalled, instead of an attachment that stays in a mailbox for good.",
    category: "crm",
    audience: "everyone",
    keywords: ["secure link", "send file securely", "ID copy", "bank statement", "recall", "expiry", "read receipt", "attachment", "POPIA", "sensitive document"],
    body: [
      { type: "p", text: "An attachment is a copy you can never take back. It sits in the customer's mailbox, and in every mailbox it is forwarded to, for good. A **secure link** keeps the file with you and puts only a link in the email. The link stops working on a date you choose, you can recall it at once if it went to the wrong person, and you are told when the file is first downloaded." },
      { type: "h", text: "Send a file as a secure link" },
      {
        type: "steps",
        items: [
          "Open the lead or contact, go to **Communications** and click **Send email**.",
          "Add the file with **Attach from library** or **Upload a file**.",
          "Tick **Send this file as a secure link, not an attachment**.",
          "Choose how long the link works: 1, 3, 7, 14 or 30 days.",
          "Click **Preview** to see how the email will look. The files are listed in a box under your message.",
          "Click **Send email**.",
        ],
      },
      { type: "p", text: "The option applies to every file on that email. To send some files as attachments and others as links, send two emails." },
      { type: "h", text: "What the customer sees" },
      {
        type: "steps",
        items: [
          "Your email arrives with a box listing each file, its size and the date the link stops working.",
          "They click a file name. A page opens with your company name, the file name and a **Download** button.",
          "They click **Download** and the file is saved.",
        ],
      },
      { type: "p", text: "They need no account and no password. If the link has expired or been recalled, the page says so and asks them to contact you." },
      { type: "h", text: "See what happened, and recall a link" },
      { type: "p", text: "Once a secure link has been sent, a **Files sent as secure links** panel appears on that lead's or contact's **Communications** tab, above the timeline." },
      {
        type: "table",
        headers: ["You see", "Meaning"],
        rows: [
          ["Not downloaded yet", "Nobody has pressed Download."],
          ["Downloaded, with a date and time", "Someone holding the link pressed Download. A number after it shows how many times."],
          ["Works until …", "The link is live until that date."],
          ["Expired …", "The date passed. The link no longer works."],
          ["Recalled …", "A member of your team withdrew it."],
        ],
      },
      { type: "p", text: "To withdraw a link, click **Recall** beside it and confirm. It stops working straight away. Whoever sent the file also gets a notification the first time it is downloaded." },
      { type: "callout", tone: "warning", text: "Recall stops the link. It cannot take back a copy that somebody has already downloaded. If a file went to the wrong person, recall it immediately and check whether it shows as downloaded." },
      { type: "callout", tone: "info", text: "**Downloaded** does not prove who downloaded it. Anyone the email is forwarded to can use the link until it expires or is recalled. A secure link limits how long and how far a document travels; it does not check the reader's identity." },
      { type: "callout", tone: "tip", text: "When you attach a file whose name looks like a personal document — an ID copy, a bank statement, a payslip — the composer suggests a secure link. It only reads the file's name, so it will not notice a scan called \"Document1.pdf\"." },
      { type: "h", text: "Limits" },
      {
        type: "list",
        items: [
          "The same file limits as attachments apply: the composer says how many files and how large.",
          "A recalled link cannot be switched back on. Send the file again.",
          "Secure links need the CRM's private file store. Where that is not switched on, the composer says so and sends nothing; attach the file instead.",
          "Secure links are offered in the email composer. Quotes and signing documents have their own secure signing links.",
        ],
      },
    ],
  },
  {
    slug: "email-check-before-sending",
    title: "The check before an email is sent",
    summary: "The composer stops and asks when an email carries an ID number, bank or card details, or a personal document to an address that is not on the customer's record.",
    category: "crm",
    audience: "everyone",
    keywords: ["sensitive data", "warning", "ID number", "bank details", "card number", "wrong address", "check before you send", "data leak", "POPIA", "send anyway"],
    body: [
      { type: "p", text: "Sending someone's ID number or bank details to the wrong address is easy to do and impossible to undo. So when you press **Send email**, the CRM takes a moment to look at what you wrote and where it is going." },
      { type: "h", text: "What it looks for" },
      {
        type: "table",
        headers: ["In the email", "How it is recognised"],
        rows: [
          ["A South African ID number", "13 digits that start with a real date of birth and end in the right check digit."],
          ["A card number", "13 to 19 digits that pass the check card numbers use."],
          ["Bank account details", "A number next to words such as \"account number\" or \"branch code\"."],
          ["A personal document", "An attachment whose name says what it is: ID, passport, licence, bank statement, payslip, proof of address, FICA."],
        ],
      },
      { type: "h", text: "When it stops you" },
      { type: "p", text: "Only when two things are true together: the email has one of the things above, **and** it is going to an address that is not on this customer's record. An ID number going to the customer's own address is not stopped. Neither is an ordinary email going anywhere." },
      { type: "p", text: "A panel headed **Check before you send** appears and says what was found and which address is not on the record. Nothing has been sent." },
      {
        type: "list",
        items: [
          "**Go back and change it** returns you to the email with everything as you left it — fix the address, or send the file as a secure link.",
          "**Send anyway** sends it. Use this when the address is right, for example the customer's finance broker.",
        ],
      },
      { type: "callout", tone: "info", text: "A personal document sent as a **secure link** is still asked about. The link expires and can be recalled, but it does not check who opens it: whoever receives the email can download the file straight away. The warning says so." },
      { type: "callout", tone: "info", text: "When someone chooses **Send anyway**, the audit log records that the email was sent after a warning and what kind of thing was found. It never records the number itself — an ID, card or bank account number in the subject line or a file name is replaced with \"[number removed]\" in the audit entry." },
      { type: "h", text: "What it does not do" },
      {
        type: "list",
        items: [
          "It does not read inside attachments. An ID number inside a PDF or a photo is not seen; only the file's name is.",
          "It does not recognise passport numbers, foreign ID numbers or tax numbers.",
          "It checks emails written in the CRM's composer. It does not check WhatsApp messages, quotes or email sent from Outlook or a phone.",
          "It can be wrong both ways. Treat a warning as a reason to look again, and the lack of one as no guarantee.",
        ],
      },
      { type: "callout", tone: "tip", text: "If the warning keeps appearing for an address you use often, add that address to the customer's record. Then it is no longer a stranger." },
    ],
  },
];
