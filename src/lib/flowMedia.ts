import type { ContactCard, OutMsg } from "./flow";

/**
 * Pure helpers for the flow messages that are not plain text: documents and
 * contact cards. No database, no network — so the per-channel shapes are tested
 * directly (tests/flowDocumentsAndCards.test.ts).
 */

/** A contact card as text, for channels with no contact message (Messenger, Instagram, Telegram). */
export function contactCardText(card: ContactCard): string {
  const lines = [`📇 ${card.name}`];
  if (card.title || (card.organization && card.organization !== card.name)) lines.push([card.title, card.organization !== card.name ? card.organization : ""].filter(Boolean).join(", "));
  for (const phone of card.phones) lines.push(`📞 ${phone}`);
  if (card.email) lines.push(`✉️ ${card.email}`);
  if (card.website) lines.push(`🌐 ${card.website}`);
  if (card.address) lines.push(`📍 ${card.address}`);
  return lines.join("\n");
}

/**
 * Meta Cloud API `contacts` message body (type: "contacts").
 * `name.formatted_name` is required and Meta also wants at least one name part,
 * so the whole name goes in `first_name` — splitting "Denago Cape Town" into a
 * first and last name would only be wrong.
 */
export function whatsappContactsMessage(to: string, card: ContactCard): Record<string, unknown> {
  const contact: Record<string, unknown> = {
    name: { formatted_name: card.name, first_name: card.name },
  };
  if (card.organization || card.title) contact.org = { ...(card.organization ? { company: card.organization } : {}), ...(card.title ? { title: card.title } : {}) };
  if (card.phones.length) contact.phones = card.phones.map((phone) => ({ phone, type: "WORK" }));
  if (card.email) contact.emails = [{ email: card.email, type: "WORK" }];
  if (card.website) contact.urls = [{ url: card.website, type: "WORK" }];
  if (card.address) contact.addresses = [{ street: card.address, type: "WORK" }];
  return { to, type: "contacts", contacts: [contact] };
}

/**
 * What a channel that cannot carry a file sends instead of the document. Never a
 * link: the file is the workspace's, and a link in a chat is a permanent copy of
 * it outside the CRM's control.
 */
export function documentFallbackText(fileName: string | undefined, caption: string | undefined): string {
  return [
    `📄 ${fileName || "Document"}`,
    caption,
    "We can't send files on this channel — reply here and the team will send it to you another way.",
  ].filter(Boolean).join("\n");
}

/** What the document is called on the timeline and in transcripts. */
export function documentLabel(message: { fileName?: string; caption?: string }): string {
  return `📄 ${message.fileName || "[document]"}${message.caption ? `\n${message.caption}` : ""}`;
}

/** One readable line (or block) for any flow message — timeline, AI history, evaluations. */
export function outMsgText(message: OutMsg): string {
  if (message.type === "text") return message.text;
  if (message.type === "image") return message.caption || "[image]";
  if (message.type === "document") return documentLabel(message);
  if (message.type === "contact") return contactCardText(message.card);
  return `${message.text}\n${message.options.map((o) => `• ${o.label}`).join("\n")}`;
}
