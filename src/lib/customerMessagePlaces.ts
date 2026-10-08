import { SIGNING_EMAILS, SIGNING_EMAIL_KINDS, isTextTemplate, type SigningEmailKind } from "./signing/emailTemplates";

/**
 * WHERE EACH CUSTOMER MESSAGE IS EDITED — next to the thing that sends it
 * (Sean, 2026-10-07: "these templates are in the wrong place. Buried in
 * settings under email").
 *
 *   documents → Document Studio: the emails that send a document (quote email,
 *               signing invitation / reminder / signed copy / code).
 *   automatic → Journeys → Customer messages: what the CRM sends by itself
 *               (service reminders, recalls, review requests, surveys).
 *   settings  → Settings → Email: login and lookup codes, rarely touched.
 *
 * One map, so every link to a message (Automatic jobs & messages, the journey
 * builder) lands where it now lives. A group not listed falls back to Settings,
 * so a new message can never end up with no editor at all.
 */
export type MessagePlace = "documents" | "automatic" | "settings";

const PLACE_BY_GROUP: Record<string, MessagePlace> = {
  "Signing & quotes": "documents",
  "Service & aftersales": "automatic",
  "Reviews & surveys": "automatic",
  "Login & verification codes": "settings",
};

export const MESSAGE_PLACES: Record<MessagePlace, { path: string; label: string }> = {
  documents: { path: "/document-studio", label: "Document Studio" },
  automatic: { path: "/journeys/messages", label: "Journeys → Customer messages" },
  settings: { path: "/settings?tab=email", label: "Settings → Email" },
};

export const messagePlace = (kind: SigningEmailKind): MessagePlace => PLACE_BY_GROUP[SIGNING_EMAILS[kind].group] ?? "settings";

export const kindsAt = (place: MessagePlace): SigningEmailKind[] => SIGNING_EMAIL_KINDS.filter((kind) => messagePlace(kind) === place);
/** The emails of a place — designed in the document editor (EmailDesignCards). */
export const emailKindsAt = (place: MessagePlace) => kindsAt(place).filter((kind) => !isTextTemplate(SIGNING_EMAILS[kind]));
/** The texts and WhatsApp messages of a place — edited as text (CustomerMessageEditors). */
export const textKindsAt = (place: MessagePlace) => kindsAt(place).filter((kind) => isTextTemplate(SIGNING_EMAILS[kind]));

/** The link that opens one message's editor, wherever it lives. */
export function messageEditorHref(kind: SigningEmailKind): string {
  const { path } = MESSAGE_PLACES[messagePlace(kind)];
  return `${path}${path.includes("?") ? "&" : "?"}open=${kind}#template-${kind}`;
}
