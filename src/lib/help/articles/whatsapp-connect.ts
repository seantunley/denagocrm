import type { HelpArticle } from "../types";

// Connect WhatsApp (Meta's Embedded Signup). Wording follows WhatsAppConnectBox, WhatsAppConnectButton, the
// sign-up window (app/connect/whatsapp) and the errors in lib/whatsappConnect.ts — change them together.
export const whatsappConnectArticles: HelpArticle[] = [
  {
    slug: "connect-whatsapp-button",
    title: "Connect WhatsApp with one button",
    summary: "Connect your own WhatsApp number from Settings: sign in with Facebook, verify the number, and messages arrive in this workspace only.",
    category: "comms",
    audience: "admins",
    keywords: ["WhatsApp", "connect WhatsApp", "Embedded Signup", "WhatsApp Business", "WABA", "number", "PIN", "two-step verification", "disconnect", "WhatsApp Manager", "payment method"],
    body: [
      { type: "p", text: "**Connect WhatsApp** links your business's own WhatsApp number to this workspace. You don't need a Meta developer account or any pasted keys: you sign in with Facebook in a window from Meta, choose or create your WhatsApp Business account, and verify the number. Messages to that number then arrive in this workspace's inbox, and replies go out from it." },
      { type: "callout", tone: "info", text: "The button appears under **Settings → Integrations → WhatsApp** once WhatsApp connections are switched on for this CRM. If you don't see it, connections aren't switched on yet; you can still set a number up the older way, with your own Meta app (see **Connecting WhatsApp Business (Cloud API)**)." },
      { type: "h", text: "Before you start" },
      { type: "list", items: [
        "You must be a workspace **owner**.",
        "Have a **Facebook account** that can manage your business, or that can create a business portfolio in Meta.",
        "Have the **phone** for the number with you. Meta sends a code by SMS or voice call.",
        "Use a number that is **not** on the WhatsApp or WhatsApp Business phone app. A number can be on the app or on this connection, not both. To use one that is on the app, delete it from the app first (Meta explains how), then connect it here.",
        "Open Settings from your workspace's own address. A connection started from another address is refused.",
        "Allow pop-up windows for the CRM. The sign-up runs in its own window.",
      ] },
      { type: "h", text: "Connect your number" },
      { type: "steps", items: [
        "Open **Settings → Integrations → WhatsApp** and press **Connect WhatsApp**. A window opens.",
        "Sign in with Facebook and follow Meta's steps: choose or create your business portfolio, choose or create a WhatsApp Business account, enter the business's display name, then add and verify the number.",
        "Finish every screen until Meta says you're done. Closing the window early cancels the connection and nothing is saved.",
        "The window says **Done — returning you to Settings**. Back in Settings, the card shows **Connecting your number…** and then **Connected:** with the number.",
        "Note the **two-step verification PIN** shown on the card. The CRM set it on the number for you. Keep it safe: Meta asks for it if the number ever moves to another provider.",
        "Send a WhatsApp message to the number from another phone. It should appear in the inbox within a few seconds.",
      ] },
      { type: "h", text: "Pay Meta for messages" },
      { type: "p", text: "Meta charges for some WhatsApp conversations and bills **your own** WhatsApp Business account, not the CRM. Add a payment method in **WhatsApp Manager** (business.facebook.com). Until you do, Meta may refuse to send some messages, such as template messages to customers who haven't written to you recently." },
      { type: "h", text: "One number, one workspace" },
      { type: "list", items: [
        "A WhatsApp number can be connected to **one** workspace only. The same goes for its WhatsApp Business account: two workspaces can't share one account, because Meta sends all of an account's messages to one place.",
        "If your workspace already had a number set up the older way (a pasted phone number ID and access token), connecting **replaces** it. If the connection fails part-way, the older settings are put back.",
        "**Connect a different number** replaces the connected one. If the new number is on a different WhatsApp Business account, the CRM asks Meta to stop sending the old account's messages here.",
      ] },
      { type: "h", text: "Disconnect" },
      { type: "p", text: "Press **Disconnect** on the card and confirm. Messages to the number stop arriving in this workspace. The number stays yours and stays registered with Meta, and conversations already in the CRM stay where they are." },
      { type: "callout", tone: "warning", text: "Disconnect removes WhatsApp from this workspace completely, including any number that was set up the older way before you connected. To go back to the older way, enter the phone number ID and access token again." },
      { type: "callout", tone: "tip", text: "If the card says **Still asking Meta to stop sending messages** from an account you no longer use here, Meta didn't confirm the last request. The CRM tries again every 6 hours and tells the owner if it keeps failing. You can also remove the app from that WhatsApp Business account yourself in **Meta Business settings**." },
      { type: "h", text: "If something goes wrong" },
      { type: "table", headers: ["Message", "What to do"], rows: [
        ["Your browser blocked the window", "Allow pop-ups for the CRM's address, then press the button again."],
        ["Sign-up was cancelled, so nothing was connected", "The window was closed or a Meta step was cancelled. Press the button again and finish every screen."],
        ["That kind of number can't be connected here", "The number is on the WhatsApp Business phone app. Use another number, or remove it from the app first."],
        ["Meta didn't finish the sign-up / That sign-up has expired", "The sign-up took too long or Meta stopped part-way. Press the button again; nothing was saved."],
        ["That WhatsApp number (or Business account) is already connected to another workspace", "Disconnect it in the other workspace first, or connect a number from a different WhatsApp Business account."],
        ["That number isn't in the WhatsApp account you signed in with", "Sign in with the Facebook account that manages that WhatsApp Business account, and pick the same number."],
        ["Open Settings from your workspace's own address", "Go to your workspace's usual CRM address and start again from Settings there."],
        ["Connect WhatsApp isn't set up on this CRM yet", "WhatsApp connections aren't switched on yet. Ask your CRM provider."],
        ["Meta didn't register the number / any other Meta message", "Nothing was connected. Wait a few minutes and try again. If it repeats, send the exact message to support."],
      ] },
      { type: "callout", tone: "warning", text: "Never share the PIN or your Facebook sign-in with anyone who asks for it by message. The CRM never asks for them; the PIN is shown only to owners on the Settings card." },
    ],
  },
];
