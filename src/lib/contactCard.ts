/**
 * "Save my contact" on email signatures (Sean, 2026-11-20: "A contact card. A 'Save my contact' link or QR code in the
 * signature that adds the person to the customer's phone"). Pure: the owner's choice and the contact card itself (a
 * vCard, the file every phone's contacts app opens). The signed link and the public route are lib/contactCardServer.ts
 * and /api/contact-card/[token].
 */

/** The owner's choice, on the workspace's signature design. Absent = off. */
export const CONTACT_CARD_CHOICES = ["link", "qr"] as const;
export type ContactCardChoice = (typeof CONTACT_CARD_CHOICES)[number];

export const CONTACT_CARD_LABELS: Record<"off" | ContactCardChoice, string> = {
  off: "Off",
  link: "A “Save my contact” link",
  qr: "The link and a QR code (for customers reading on a computer: they scan it with their phone)",
};

export const parseContactCard = (value: unknown): ContactCardChoice | undefined =>
  CONTACT_CARD_CHOICES.includes(value as ContactCardChoice) ? (value as ContactCardChoice) : undefined;

/** A vCard value: backslash, comma, semicolon and line breaks escaped (RFC 6350 §3.4). */
const esc = (value: string) => value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);

/** The Company profile's address arrives entity-encoded HTML (lib/signature.ts): plain text for a phone. */
const plainText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;|&#183;/g, "·")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export type ContactCardPerson = {
  name: string;
  email: string;
  mobile?: string | null;
  jobTitle?: string | null;
  directLine?: string | null;
  whatsapp?: string | null;
};
export type ContactCardCompany = { name: string; website: string; switchboard: string; address: string };

/**
 * The person as a contact card: the details their signature shows, each line only when set. vCard 3.0 — the version
 * every iPhone, Android and Outlook reads. No photo: it is the person's, and the card is public to anyone with the link.
 */
export function vCard(person: ContactCardPerson, company: ContactCardCompany): string {
  const name = person.name.trim();
  const split = name.lastIndexOf(" ");
  const [first, last] = split > 0 ? [name.slice(0, split), name.slice(split + 1)] : [name, ""];
  const mobile = person.mobile?.trim() ?? "";
  const numbers = new Set<string>();
  // One line per distinct number: a WhatsApp or office number that is the mobile is not listed twice.
  const tel = (type: string, number: string | null | undefined) => {
    const n = (number ?? "").trim();
    const key = n.replace(/\D/g, "");
    if (!key || numbers.has(key)) return "";
    numbers.add(key);
    return `TEL;TYPE=${type}:${esc(n)}`;
  };
  const website = company.website.trim().replace(/^https?:\/\//i, "");
  const address = plainText(company.address);
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${esc(last)};${esc(first)};;;`,
    `FN:${esc(name)}`,
    company.name.trim() ? `ORG:${esc(company.name.trim())}` : "",
    person.jobTitle?.trim() ? `TITLE:${esc(person.jobTitle.trim())}` : "",
    tel("CELL", mobile),
    tel("WORK,VOICE", person.directLine),
    tel("CELL", person.whatsapp),
    tel("WORK,MAIN", company.switchboard),
    person.email.trim() ? `EMAIL;TYPE=INTERNET,WORK:${esc(person.email.trim())}` : "",
    website ? `URL:${esc(`https://${website}`)}` : "",
    address ? `ADR;TYPE=WORK:;;${esc(address)};;;;` : "",
    "END:VCARD",
  ]
    .filter(Boolean)
    .join("\r\n")
    .concat("\r\n");
}

/** "Thandi Nkosi.vcf" — the name a phone shows for the download; nothing a file name can't hold. */
export const contactCardFileName = (name: string) =>
  `${name.replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 80).replace(/^[. ]+|[. ]+$/g, "") || "Contact"}.vcf`;
