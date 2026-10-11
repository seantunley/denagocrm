/**
 * The check before an email goes — the rules, pure (Sean, 2026-10-11, after
 * looking at Mimecast's data leak prevention: "a check in the composer for ID
 * numbers or bank details going to an address that isn't the customer's").
 *
 * It looks for the two things that do real harm in the wrong inbox — an identity
 * number and bank or card details — and asks one question about where the email
 * is going: is every recipient an address already on this customer's record?
 * When sensitive content is headed anywhere else, the sender is stopped and
 * asked to look again. They may still send; the point is that it is a decision.
 *
 * Deliberately narrow. It reads the subject and message, and the NAMES of the
 * attached files — not their contents. It will miss an ID number inside a PDF,
 * and it says so wherever it is described. A check that claimed more would be
 * trusted more than it deserves.
 */

export type SensitiveKind = "sa-id" | "card" | "bank-account" | "file-name";
export type SensitiveFinding = { kind: SensitiveKind; label: string };

const digitsOf = (value: string) => value.replace(/\D/g, "");

/** Luhn check, as used by payment cards and South African ID numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * A South African ID number: 13 digits, starting with a real date of birth
 * (YYMMDD), with a valid check digit. All three, so that a 13-digit order or
 * tracking number is not mistaken for one.
 */
export function isSaIdNumber(value: string): boolean {
  const d = digitsOf(value);
  if (d.length !== 13) return false;
  const month = Number(d.slice(2, 4));
  const day = Number(d.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (!["0", "1", "2"].includes(d[10])) return false; // citizenship digit: 0 citizen, 1 resident, 2 refugee
  return luhnValid(d);
}

/** A payment card number: 13–19 digits passing Luhn, starting with a digit card schemes use. */
export function isCardNumber(value: string): boolean {
  const d = digitsOf(value);
  return d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && !/^(\d)\1+$/.test(d) && luhnValid(d);
}

/** File names that say what is inside: an ID, a passport, a bank statement, a payslip, proof of address or payment. */
const SENSITIVE_FILE = /(^|[^a-z])(id|i\.d|identity|id[-_ ]?copy|id[-_ ]?doc(ument)?|passport|licen[cs]e|bank|statement|payslip|pay[-_ ]?slip|salary|proof[-_ ]?of|fica|kyc|tax|irp5|credit[-_ ]?(app|report|check)|finance[-_ ]?app)([^a-z]|$)/i;
export const looksSensitiveFile = (name: string) => SENSITIVE_FILE.test(name.replace(/\.[a-z0-9]{1,5}$/i, ""));

// Runs of digits, allowing the spaces and dashes people type inside long numbers.
const DIGIT_RUN = /\d(?:[ -]?\d){8,18}/g;
// A bank account: 8–12 digits with the words that go with one nearby. The words are what
// separate it from a phone number or a quote number, which this must not flag.
const BANK_ACCOUNT = /(?:acc(?:ount|t)?\.?\s*(?:no|number|nr|#)?|banking details|branch code|iban)\s*[:\-#.]?\s*([\d][\d -]{6,16}\d)/gi;

/**
 * What in this email is sensitive. Each KIND is reported once, as a label a
 * person can read — never the number itself, which must not end up in a
 * warning, a log or an audit entry.
 */
export function sensitiveFindings(text: string, fileNames: readonly string[] = []): SensitiveFinding[] {
  const found = new Map<SensitiveKind, string>();
  for (const [run] of text.matchAll(DIGIT_RUN)) {
    const d = digitsOf(run);
    if (isSaIdNumber(d)) found.set("sa-id", "an ID number");
    else if (isCardNumber(d)) found.set("card", "a card number");
  }
  for (const match of text.matchAll(BANK_ACCOUNT)) {
    const d = digitsOf(match[1]);
    if (d.length >= 8 && d.length <= 12) found.set("bank-account", "bank account details");
  }
  const files = fileNames.filter(looksSensitiveFile);
  if (files.length > 0) found.set("file-name", files.length === 1 ? `an attachment that looks like a personal document (“${files[0].slice(0, 60)}”)` : `${files.length} attachments that look like personal documents`);
  return [...found].map(([kind, label]) => ({ kind, label }));
}

const addressesOf = (list: string | null | undefined) =>
  [...new Set((list ?? "").split(/[,;]/).map((address) => address.trim().toLowerCase()).filter(Boolean))];

/**
 * The recipients that are NOT an address on the customer's record. With no
 * record to compare against, that is all of them: an email composed from nowhere
 * in particular has no customer whose address could vouch for it.
 */
export function recipientsOffRecord(to: string, customerAddresses: readonly (string | null | undefined)[]): string[] {
  const known = new Set(customerAddresses.map((address) => (address ?? "").trim().toLowerCase()).filter(Boolean));
  return addressesOf(to).filter((address) => !known.has(address));
}

export type SendWarning = { text: string; kinds: SensitiveKind[] };

/**
 * Should the sender be stopped and asked? Only when there is something
 * sensitive AND somewhere it should not obviously go. A file sent as a secure
 * link is asked about like any other: the link expires and can be recalled, but
 * it does not check who opens it, so the wrong person can download the file the
 * moment it arrives. The warning says so rather than staying quiet.
 */
export function sendWarning(input: {
  subject: string;
  bodyText: string;
  fileNames: readonly string[];
  /** Attachments are going as secure links, not as copies. */
  secureLinks: boolean;
  to: string;
  customerAddresses: readonly (string | null | undefined)[];
}): SendWarning | null {
  const findings = sensitiveFindings(`${input.subject}\n${input.bodyText}`, input.fileNames);
  if (findings.length === 0) return null;
  const strangers = recipientsOffRecord(input.to, input.customerAddresses);
  if (strangers.length === 0) return null;
  const what = findings.map((finding) => finding.label);
  const list = what.length === 1 ? what[0] : `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}`;
  const who = strangers.length === 1 ? strangers[0] : `${strangers.length} addresses`;
  const known = input.customerAddresses.some((address) => (address ?? "").trim());
  const viaLink = input.secureLinks && findings.some((finding) => finding.kind === "file-name");
  return {
    kinds: findings.map((finding) => finding.kind),
    text: `This email has ${list}, and it is going to ${who}, which ${strangers.length === 1 ? "is" : "are"} not ${known ? "the address on this customer's record" : "an address on any customer record here"}.${
      viaLink ? " A secure link expires and can be recalled, but it does not check who opens it — whoever receives this email can download the file straight away." : ""
    }`,
  };
}

/**
 * The same text with any ID, card or bank account number taken out — for
 * anything that outlives the email itself (the audit trail). The email's own
 * subject stays as written on the timeline; a log must not be a second copy.
 */
export function redactSensitive(text: string): string {
  const REMOVED = "[number removed]";
  return text
    .replace(BANK_ACCOUNT, (whole: string, number: string) => {
      const d = digitsOf(number);
      return d.length >= 8 && d.length <= 12 ? whole.replace(number, REMOVED) : whole;
    })
    .replace(DIGIT_RUN, (run) => (isSaIdNumber(run) || isCardNumber(run) ? REMOVED : run));
}

/** A softer nudge, shown while composing: this file would be better as a secure link. Never blocks. */
export function secureLinkHint(fileNames: readonly string[], secureLinks: boolean): string | null {
  if (secureLinks) return null;
  const files = fileNames.filter(looksSensitiveFile);
  if (files.length === 0) return null;
  return `${files.length === 1 ? `“${files[0].slice(0, 60)}” looks` : `${files.length} of these files look`} like a personal document. Sent as an attachment it stays in the customer's mailbox for good; as a secure link it expires and can be recalled.`;
}
