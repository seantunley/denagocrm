/**
 * Standard email wording that has been REPLACED — kept only so a draft that was
 * seeded from it, and never edited, can be recognised and brought up to the
 * current standard (./emailSeeding.ts).
 *
 * "Never edited" is decided by CONTENT: the draft is exactly what seeding from
 * one of these produced. Not by timestamps (review of #807: the editor
 * autosaves ~1.2s after a keystroke, so "saved within 5s of being created"
 * could be a real first edit — and the refresh would have overwritten it).
 * An edit of any size makes the draft differ from every seed here, for good.
 *
 * Append a revision when the standard wording in signing/emailTemplates.ts and
 * the headlines in ./emailDefaults.ts are rewritten again; never edit one.
 */
import type { SigningEmailKind } from "../signing/emailTemplates";

export type EmailWording = { subject: string; body: string; headline: string };

/** What #806 seeded (the wording on main until 2026-10-08). */
export const STANDARD_WORDING_2026_10_07: Partial<Record<SigningEmailKind, EmailWording>> = {
  invite: {
    subject: "Please sign your document: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nPlease review and sign {{document_title}}.\n\n{{signing_link}}\n\nThank you,\n{{company_name}}",
    headline: "Please sign {{document_title}}",
  },
  reminder: {
    subject: "Reminder — please sign: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nReminder — please review and sign {{document_title}}.\n\n{{signing_link}}\n\nThank you,\n{{company_name}}",
    headline: "A reminder to sign {{document_title}}",
  },
  completed: {
    subject: "Completed & signed: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nEveryone has signed \"{{document_title}}\". The final sealed PDF is attached.\n\n{{company_name}}",
    headline: "Everyone has signed",
  },
  otp: {
    subject: "Verification code: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nYour verification code for “{{document_title}}” is:\n\n{{code}}\n\nIt expires in 10 minutes. If you did not ask to sign this document, ignore this message and tell the sender.",
    headline: "Your verification code",
  },
  quote: {
    subject: "Your quote {{quote_number}} from {{company_name}}",
    body: "Hi {{first_name}},\n\nThank you for your interest. Your quote {{quote_number}} is attached as a PDF.\n\nIf you have any questions, or would like to go ahead, just reply to this email.\n\nKind regards,\n{{sender_name}}\n{{company_name}}",
    headline: "Your quote {{quote_number}}",
  },
  portal_code: {
    subject: "Your {{company_name}} portal code",
    body: "Your login code is {{code}}. It expires in 10 minutes.\n\nIf you didn't request this, ignore this email.\n\n{{company_name}}",
    headline: "Your login code",
  },
  lookup_code: {
    subject: "Your {{company_name}} verification code",
    body: "Your verification code is {{code}}.\n\nIt expires in 10 minutes. If you didn't request this, you can ignore this email.\n\n{{company_name}}",
    headline: "Your verification code",
  },
  service_reminder: {
    subject: "Service reminder — your {{model}}",
    body: "Hi {{first_name}},\n\nA quick reminder that your {{model}} is due for a service ({{due_date}}). Reply or call {{company_contact}} and we'll book you in.\n\nWarm regards,\n{{company_name}}",
    headline: "Time for a service",
  },
  recall: {
    subject: "Important: {{recall_title}} — your {{model}}",
    body: "Hi {{first_name}},\n\n{{recall_description}}\n\nPlease contact {{company_contact}} to arrange this at no charge.\n\nWarm regards,\n{{company_name}}",
    headline: "{{recall_title}}",
  },
  review_delivery: {
    subject: "Enjoying your new {{item}}? We'd love a quick review ⭐",
    body: "Hi {{first_name}},\n\nCongratulations on your new {{item}} — welcome to the {{company_name}} family! 🎉\n\nIf you're enjoying it, it would mean the world to us if you shared your experience in a quick Google review (it takes under a minute):\n\n{{review_link}}\n\nAnything you need, just call {{company_contact}}.\n\nWarm regards,\n{{company_name}}",
    headline: "Enjoying your new {{item}}?",
  },
  review_service: {
    subject: "How was your service? A quick review would mean a lot ⭐",
    body: "Hi {{first_name}},\n\nThanks for trusting us with {{item}} — we hope everything is running perfectly.\n\nIf you were happy with the service, a quick Google review would mean a lot to our small team (it takes under a minute):\n\n{{review_link}}\n\nAnything not 100%? Rather call {{company_contact}} first and we'll make it right.\n\nWarm regards,\n{{company_name}}",
    headline: "How was your service?",
  },
  survey_invite: {
    subject: "{{survey_subject}}",
    body: "Hi {{first_name}},\n\n{{survey_intro}}\n\nTap below to answer (it takes under a minute):\n\n{{survey_link}}\n\nThank you,\n{{company_name}}",
    headline: "{{survey_title}}",
  },
  survey_reminder: {
    subject: "{{survey_title}}",
    body: "Hi {{first_name}},\n\nA quick reminder: {{survey_intro}}\n\n{{survey_link}}\n\nThank you,\n{{company_name}}",
    headline: "{{survey_title}}",
  },
};

/** Every replaced revision, oldest first. */
export const REPLACED_STANDARD_WORDINGS = [STANDARD_WORDING_2026_10_07];
