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

export type EmailWording = {
  subject: string;
  body: string;
  headline: string;
  // The original seeded document's design labels, independent of today's defaults.
  buttonLabel?: string;
  quoteLabel?: string;
};

/** What #806 seeded (the wording on main until 2026-10-08). */
export const STANDARD_WORDING_2026_10_07: Partial<Record<SigningEmailKind, EmailWording>> = {
  invite: {
    subject: "Please sign your document: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nPlease review and sign {{document_title}}.\n\n{{signing_link}}\n\nThank you,\n{{company_name}}",
    headline: "Please sign {{document_title}}",
    buttonLabel: "Open & sign",
  },
  reminder: {
    subject: "Reminder — please sign: {{document_title}}",
    body: "Hi {{recipient_name}},\n\nReminder — please review and sign {{document_title}}.\n\n{{signing_link}}\n\nThank you,\n{{company_name}}",
    headline: "A reminder to sign {{document_title}}",
    buttonLabel: "Open & sign",
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
    quoteLabel: "QUOTE",
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
    buttonLabel: "Leave a review",
  },
  review_service: {
    subject: "How was your service? A quick review would mean a lot ⭐",
    body: "Hi {{first_name}},\n\nThanks for trusting us with {{item}} — we hope everything is running perfectly.\n\nIf you were happy with the service, a quick Google review would mean a lot to our small team (it takes under a minute):\n\n{{review_link}}\n\nAnything not 100%? Rather call {{company_contact}} first and we'll make it right.\n\nWarm regards,\n{{company_name}}",
    headline: "How was your service?",
    buttonLabel: "Leave a review",
  },
  survey_invite: {
    subject: "{{survey_subject}}",
    body: "Hi {{first_name}},\n\n{{survey_intro}}\n\nTap below to answer (it takes under a minute):\n\n{{survey_link}}\n\nThank you,\n{{company_name}}",
    headline: "{{survey_title}}",
    buttonLabel: "Answer the survey",
  },
  survey_reminder: {
    subject: "{{survey_title}}",
    body: "Hi {{first_name}},\n\nA quick reminder: {{survey_intro}}\n\n{{survey_link}}\n\nThank you,\n{{company_name}}",
    headline: "{{survey_title}}",
    buttonLabel: "Answer the survey",
  },
};

/** The professional rewrite that shipped on 2026-10-08, before the premium customer-experience pass. */
export const STANDARD_WORDING_2026_10_08: Partial<Record<SigningEmailKind, EmailWording>> = {
  invite: {
    subject: "{{document_title}} is ready for your signature",
    body: "Dear {{recipient_name}},\n\n{{document_title}} is ready for your review. You can read it in full and sign it securely online, from any phone or computer, in a few minutes.\n\n{{signing_link}}\n\nIf anything needs to change, or you would prefer not to go ahead, please choose Decline on the same page and tell us why. We will be in touch.\n\nKind regards,\n{{company_name}}",
    headline: "{{document_title}} is ready for your signature",
    buttonLabel: "Open & sign",
  },
  reminder: {
    subject: "Reminder: {{document_title}} is awaiting your signature",
    body: "Dear {{recipient_name}},\n\nThis is a courtesy reminder that {{document_title}} is still awaiting your signature. You can review and sign it securely online using the button below.\n\n{{signing_link}}\n\nIf you have any questions, or would prefer not to go ahead, please reply to this email or choose Decline on the signing page.\n\nKind regards,\n{{company_name}}",
    headline: "{{document_title}} is awaiting your signature",
    buttonLabel: "Open & sign",
  },
  completed: {
    subject: "Your signed copy of {{document_title}}",
    body: "Dear {{recipient_name}},\n\nThank you. {{document_title}} has now been signed by all parties, and the completed copy is attached to this email for your records.\n\nIf you have any questions, we will be glad to help.\n\nKind regards,\n{{company_name}}",
    headline: "Signed and complete",
  },
  otp: {
    subject: "Your verification code for {{document_title}}",
    body: "Dear {{recipient_name}},\n\nTo confirm your identity before signing {{document_title}}, please enter this verification code:\n\n{{code}}\n\nThe code is valid for 10 minutes. If you did not ask to sign this document, please disregard this email and let us know.\n\nKind regards,\n{{company_name}}",
    headline: "Your verification code",
  },
  quote: {
    subject: "Your quotation {{quote_number}} from {{company_name}}",
    body: "Dear {{first_name}},\n\nThank you for the opportunity to quote. Please find quotation {{quote_number}} attached as a PDF for your consideration.\n\nShould you have any questions, or wish to change anything, I will be glad to assist. Simply reply to this email. When you are ready to proceed, let me know and I will arrange the next steps.\n\nKind regards,\n{{sender_name}}\n{{company_name}}",
    headline: "Your quotation {{quote_number}}",
    quoteLabel: "QUOTE",
  },
  portal_code: {
    subject: "Your {{company_name}} login code",
    body: "Please use the code below to sign in to your {{company_name}} customer portal:\n\n{{code}}\n\nThe code is valid for 10 minutes. If you did not request it, you can safely disregard this email.\n\nKind regards,\n{{company_name}}",
    headline: "Your login code",
  },
  lookup_code: {
    subject: "Your {{company_name}} verification code",
    body: "Please use the code below to confirm your details:\n\n{{code}}\n\nThe code is valid for 10 minutes. If you did not request it, you can safely disregard this email.\n\nKind regards,\n{{company_name}}",
    headline: "Your verification code",
  },
  service_reminder: {
    subject: "Your {{model}} is due for a service",
    body: "Dear {{first_name}},\n\nOur records show that your {{model}} is due for its next service ({{due_date}}). Regular servicing keeps your vehicle safe and performing at its best.\n\nTo book a time that suits you, please reply to this email or contact {{company_contact}}.\n\nKind regards,\n{{company_name}}",
    headline: "Your {{model}} is due for a service",
  },
  recall: {
    subject: "Important notice for your {{model}}: {{recall_title}}",
    body: "Dear {{first_name}},\n\nWe are writing to you about your {{model}}.\n\n{{recall_description}}\n\nThis work will be carried out at no charge to you. Please contact {{company_contact}} at your earliest convenience so that we can arrange a suitable time.\n\nWe apologise for the inconvenience and thank you for your understanding.\n\nKind regards,\n{{company_name}}",
    headline: "{{recall_title}}",
  },
  review_delivery: {
    subject: "How are you enjoying your new {{item}}?",
    body: "Dear {{first_name}},\n\nCongratulations on your new {{item}}, and thank you for choosing {{company_name}}.\n\nWe hope you are enjoying it. If you have a moment, we would be grateful if you would share your experience in a short Google review. It takes less than a minute and helps other customers choose with confidence.\n\n{{review_link}}\n\nShould you need anything at all, please contact {{company_contact}}.\n\nKind regards,\n{{company_name}}",
    headline: "How are you enjoying your new {{item}}?",
    buttonLabel: "Leave a review",
  },
  review_service: {
    subject: "How was your recent service?",
    body: "Dear {{first_name}},\n\nThank you for entrusting us with {{item}}. We hope everything is running exactly as it should.\n\nIf you were happy with the service, we would be grateful for a short Google review. It takes less than a minute.\n\n{{review_link}}\n\nIf anything was not to your satisfaction, please contact {{company_contact}} first so that we can put it right.\n\nKind regards,\n{{company_name}}",
    headline: "How was your recent service?",
    buttonLabel: "Leave a review",
  },
  survey_invite: {
    subject: "{{survey_subject}}",
    body: "Dear {{first_name}},\n\n{{survey_intro}}\n\nYour feedback helps us to improve, and the survey takes less than a minute to complete.\n\n{{survey_link}}\n\nThank you for your time.\n\nKind regards,\n{{company_name}}",
    headline: "{{survey_title}}",
    buttonLabel: "Answer the survey",
  },
  survey_reminder: {
    subject: "Reminder: {{survey_title}}",
    body: "Dear {{first_name}},\n\nThis is a courtesy reminder about our short survey. {{survey_intro}}\n\n{{survey_link}}\n\nThank you for your time.\n\nKind regards,\n{{company_name}}",
    headline: "{{survey_title}}",
    buttonLabel: "Answer the survey",
  },
};

/** Every replaced revision, oldest first. */
export const REPLACED_STANDARD_WORDINGS = [STANDARD_WORDING_2026_10_07, STANDARD_WORDING_2026_10_08];
