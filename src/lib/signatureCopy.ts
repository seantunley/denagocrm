import { buildSignature, htmlToText, signatureAssetOrigin, type SignatureCompany } from "./signature";
import type { SignatureExtras } from "./signaturePeople";

/**
 * "Copy my signature" — the CRM's signature, for use in a mail app outside it
 * (Sean, 2026-11-20), so an email sent from Gmail, Outlook or a phone matches
 * the ones the CRM sends.
 *
 * WHAT IS COPIED is the signature the send path builds (lib/signature.ts
 * buildSignature) — the same string, so the copy cannot drift from what the
 * CRM sends. Two things differ once it leaves the CRM, and both are handled here:
 *
 *   1. PICTURES. Inside a CRM email the logo and icons travel in the message
 *      (signatureAssets.ts). A pasted signature can only LINK to them, so every
 *      address must be a full https one: `absolutise` gives a root-relative
 *      address the workspace's own origin.
 *   2. PHONE MAIL APPS take plain text only. `plainSignature` is the same
 *      details as a few lines of text, built from the fields rather than by
 *      stripping the HTML — a table-built card stripped of its tags is one
 *      run-together line.
 *
 * Pure, so it is tested.
 */

/** Give every root-relative `src` and `href` the workspace's origin. Other addresses are left alone. */
export function absolutise(html: string, origin: string): string {
  const base = origin.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(base)) return html;
  // `/path` only — not `//host` (already absolute), not `#`, `mailto:`, `tel:` or `https:`.
  return html.replace(/\b(src|href)=(["'])\/(?!\/)/gi, (_m, attr: string, quote: string) => `${attr}=${quote}${base}/`);
}

export type SignaturePerson = {
  name: string; email: string; mobile?: string | null; jobTitle?: string | null; signatureHtml?: string | null;
  /** The Email signatures pack's details and team line ({} or absent while it is off). */
  extras?: SignatureExtras; teamLine?: string;
};

/**
 * What "Copy my signature" copies: the sender's signature as the send path builds it — their details, team line, the
 * workspace's design and colour (review of #1161) — with every picture address made absolute.
 *
 * Less the dated lines (below), and the PHOTO. In a CRM email it travels inside the message; its address is for signed-in staff only, so
 * pasted into Gmail it would be a broken picture for every recipient. `photoLeftOut` says so on the screen.
 */
export function copyableSignature(
  person: SignaturePerson,
  company: SignatureCompany,
): { html: string; text: string; photoLeftOut: boolean } {
  const photoLeftOut = Boolean(person.extras?.photoUrl) && !person.signatureHtml?.trim();
  // Nor today's dated lines: a pasted copy can't take them down on their last day, so "On leave" would stay for good.
  const sender = { ...person, extras: person.extras ? { ...person.extras, photoUrl: null, notices: [] } : undefined };
  return {
    html: absolutise(buildSignature(sender, company), signatureAssetOrigin(company)),
    text: plainSignature(sender, company),
    photoLeftOut,
  };
}

/**
 * The signature as plain text, for a mail app that takes nothing else.
 * Someone using their own HTML gets that HTML's text; everyone else gets their
 * details and the company's, one per line, an unset one simply absent.
 */
export function plainSignature(person: SignaturePerson, company: Pick<SignatureCompany, "name" | "website" | "switchboard" | "design">): string {
  if (person.signatureHtml?.trim()) return htmlToText(person.signatureHtml);
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const mobile = clean(person.mobile);
  const switchboard = clean(company.switchboard);
  const title = clean(person.jobTitle);
  const companyLine = clean(company.design?.companyLine) || clean(company.name);
  const x = person.extras ?? {};
  const direct = clean(x.directLine);
  const whatsapp = clean(x.whatsapp);
  return [
    clean(person.name),
    clean(x.qualifications),
    [title, companyLine].filter(Boolean).join(" | "),
    [mobile && `M ${mobile}`, direct && `D ${direct}`, switchboard && switchboard !== mobile && `T ${switchboard}`, whatsapp && `WhatsApp ${whatsapp}`]
      .filter(Boolean)
      .join("  "),
    clean(person.email),
    clean(company.website).replace(/^https?:\/\//i, "").replace(/\/$/, ""),
    clean(x.bookingUrl) && `Book a time: ${clean(x.bookingUrl)}`,
    clean(x.hours),
    clean(x.cta),
    clean(person.teamLine),
    clean(x.contactCardUrl) && `Save my contact: ${clean(x.contactCardUrl)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export type SignatureGuide = {
  id: string;
  name: string;
  /** Which copy button this app needs: the designed signature, or plain text. */
  copy: "designed" | "plain";
  steps: string[];
  note?: string;
};

/**
 * Where to paste it. Menu names as the apps had them in November 2026 (Google's
 * and Microsoft's own help pages); they move, so every guide says what to look
 * for rather than only where to click.
 */
export const SIGNATURE_GUIDES: readonly SignatureGuide[] = [
  {
    id: "gmail",
    name: "Gmail (in a browser)",
    copy: "designed",
    steps: [
      "Press Copy my signature.",
      "In Gmail, click the Settings gear at the top right, then See all settings.",
      "On the General tab, scroll to Signature and click Create new. Give it a name.",
      "Click in the signature box and paste (Ctrl+V, or Cmd+V on a Mac).",
      "Under Signature defaults, choose it for new emails and for replies.",
      "Scroll to the bottom and click Save Changes.",
    ],
  },
  {
    id: "outlook",
    name: "Outlook (new Outlook and Outlook on the web)",
    copy: "designed",
    steps: [
      "Press Copy my signature.",
      "In Outlook, click the Settings gear at the top right.",
      "Choose Accounts, then Signatures.",
      "Click New signature and give it a name.",
      "Click in the signature box and paste (Ctrl+V, or Cmd+V on a Mac).",
      "Choose it as the default for new messages and for replies, then click Save.",
    ],
  },
  {
    id: "outlook-classic",
    name: "Outlook (classic, on Windows)",
    copy: "designed",
    steps: [
      "Press Copy my signature.",
      "In Outlook, choose File, then Options, then Mail, then Signatures.",
      "Click New and give it a name.",
      "Click in the edit box and paste (Ctrl+V).",
      "Choose it for new messages and for replies, then click OK.",
    ],
  },
  {
    id: "apple-mail",
    name: "Apple Mail (Mac)",
    copy: "designed",
    steps: [
      "Press Copy my signature.",
      "In Mail, choose Mail, then Settings, then Signatures.",
      "Pick your email account, click + and give the signature a name.",
      "Untick Always match my default message font, or the design is flattened.",
      "Click in the box on the right and paste (Cmd+V).",
    ],
  },
  {
    id: "phone",
    name: "Gmail or Outlook app on a phone",
    copy: "plain",
    steps: [
      "Open this page on your phone and press Copy as plain text.",
      "Gmail app: open the menu, then Settings, choose your account, then Mobile signature.",
      "Outlook app: open Settings, then Signature.",
      "Paste, and save.",
    ],
    note: "These phone apps keep a signature as plain text, so the logo and layout can't be used there. The details still match.",
  },
];
