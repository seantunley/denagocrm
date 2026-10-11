import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  SECURE_LINK_DEFAULT_DAYS,
  SECURE_LINK_TOKEN,
  downloadFileName,
  fileSizeLabel,
  secureLinkDays,
  secureLinkExpiry,
  secureLinkState,
  secureLinkSummary,
  secureLinksHtml,
  secureLinksText,
} from "../src/lib/secureLinks";
import { isCardNumber, isSaIdNumber, looksSensitiveFile, luhnValid, recipientsOffRecord, redactSensitive, secureLinkHint, sendWarning, sensitiveFindings } from "../src/lib/sendCheck";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const NOW = new Date("2026-11-10T10:00:00Z");

/** A made-up but well-formed South African ID number: born 1 Jan 1980, citizen, with its real check digit. */
const SA_ID = (() => { for (let d = 0; d <= 9; d++) if (luhnValid(`800101500908${d}`)) return `800101500908${d}`; throw new Error("no check digit"); })();
const CARD = "4111111111111111"; // the standard test card number

/* ── Secure links ─────────────────────────────────────────────────────────── */

test("a link lasts the days chosen, and only a listed number of days", () => {
  assert.equal(secureLinkDays("14"), 14);
  for (const bad of ["365", "0", "-1", "abc", undefined, null, "7.5"]) assert.equal(secureLinkDays(bad), SECURE_LINK_DEFAULT_DAYS, String(bad));
  assert.equal(secureLinkExpiry(NOW, 3).toISOString(), "2026-11-13T10:00:00.000Z");
  assert.equal(secureLinkExpiry(NOW, 9999).toISOString(), secureLinkExpiry(NOW, SECURE_LINK_DEFAULT_DAYS).toISOString(), "never longer than offered");
});

test("a link is active until its expiry, and a recall beats everything", () => {
  const later = new Date(NOW.getTime() + 86_400_000);
  const earlier = new Date(NOW.getTime() - 1000);
  assert.equal(secureLinkState({ expiresAt: later, revokedAt: null }, NOW), "active");
  assert.equal(secureLinkState({ expiresAt: earlier, revokedAt: null }, NOW), "expired");
  assert.equal(secureLinkState({ expiresAt: NOW, revokedAt: null }, NOW), "expired", "the moment itself is too late");
  assert.equal(secureLinkState({ expiresAt: later, revokedAt: earlier }, NOW), "recalled");
  assert.equal(secureLinkState({ expiresAt: earlier, revokedAt: earlier }, NOW), "recalled", "recalled is the more useful thing to say");
});

test("the block in the email names each file, its size and the expiry, and escapes what it shows", () => {
  const links = [{ name: 'ID copy "final" <1>.pdf', url: "https://crm.example.co.za/f/tok?x=1&y=2", sizeBytes: 1_500_000 }, { name: "Bank statement.pdf", url: "https://crm.example.co.za/f/tok2", sizeBytes: 0 }];
  const html = secureLinksHtml(links, "17 Nov 2026");
  assert.match(html, /2 files for you/);
  assert.match(html, /ID copy &quot;final&quot; &lt;1&gt;\.pdf/);
  assert.match(html, /href="https:\/\/crm\.example\.co\.za\/f\/tok\?x=1&amp;y=2"/);
  assert.match(html, /\(1\.4 MB\)/);
  assert.match(html, /until 17 Nov 2026/);
  assert.match(html, /Please don't forward them/);
  assert.doesNotMatch(html, /<script|\(\)<\/span>/, "no markup from a file name, and no empty size");
  const text = secureLinksText(links, "17 Nov 2026");
  assert.match(text, /- ID copy "final" <1>\.pdf \(1\.4 MB\): https:\/\/crm\.example\.co\.za\/f\/tok\?x=1&y=2/);
  assert.equal(secureLinksHtml([], "x"), "");
  assert.equal(secureLinksText([], "x"), "");
  assert.match(secureLinksHtml([links[0]], "17 Nov 2026"), /A file for you — open it with this secure link/);
});

test("sizes read the way people say them", () => {
  assert.equal(fileSizeLabel(0), "");
  assert.equal(fileSizeLabel(900), "900 B");
  assert.equal(fileSizeLabel(320 * 1024), "320 KB");
  assert.equal(fileSizeLabel(1.44 * 1024 * 1024), "1.4 MB");
  assert.equal(fileSizeLabel(25 * 1024 * 1024), "25 MB");
});

test("what staff see beside a link they sent", () => {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const later = new Date("2026-11-17T10:00:00Z");
  assert.deepEqual(secureLinkSummary({ expiresAt: later, revokedAt: null, firstOpenedAt: null, openCount: 0 }, NOW, fmt), { state: "active", status: "Works until 2026-11-17", opened: "Not downloaded yet" });
  assert.equal(secureLinkSummary({ expiresAt: later, revokedAt: null, firstOpenedAt: NOW, openCount: 3 }, NOW, fmt).opened, "Downloaded 2026-11-10 · 3×");
  assert.equal(secureLinkSummary({ expiresAt: later, revokedAt: NOW, firstOpenedAt: null, openCount: 0 }, NOW, fmt).status, "Recalled 2026-11-10");
});

test("a download's file name cannot break out of its header", () => {
  const name = downloadFileName('ID "copy"\r\nX-Evil: 1/../é.pdf');
  assert.doesNotMatch(name.ascii, /["\r\n\\/]/);
  assert.doesNotMatch(name.encoded, /["\r\n]/);
  assert.equal(downloadFileName("").ascii, "file");
  assert.equal(downloadFileName("Quote.pdf").ascii, "Quote.pdf");
});

test("the link's value is stored only as a hash, checked on every use, and the page hands over nothing", () => {
  const store = src("src/lib/secureLinkStore.ts");
  assert.match(store, /const token = randomBytes\(32\)\.toString\("base64url"\);/);
  assert.match(store, /token: hashSignToken\(token\),/, "the table never holds the link itself");
  assert.match(store, /where: \{ token: hashSignToken\(token\) \},/);
  assert.ok(SECURE_LINK_TOKEN.test("A".repeat(43)) && !SECURE_LINK_TOKEN.test("short") && !SECURE_LINK_TOKEN.test("a/b".repeat(20)));
  assert.match(src("src/lib/tokenTenant.ts"), /basePrisma\.secureFileLink\.findUnique\(\{\s*where: \{ token: hashSignToken\(token\) \},/);

  const route = src("src/app/api/f/[token]/route.ts");
  assert.match(route, /export async function POST\(/);
  assert.doesNotMatch(route, /export async function GET\(/, "a prefetched link downloads nothing");
  assert.match(route, /if \(link\.state === "recalled"\) return gone\(410,/);
  assert.match(route, /if \(link\.state === "expired"\) return gone\(410,/);
  assert.ok(route.indexOf('link.state === "expired"') < route.indexOf("openStoredFile("), "refused before the file is opened");
  // Read as the link's OWN workspace, served as a download, never rendered.
  assert.match(route, /openStoredFile\(link\.storedRef, link\.tenantId\)/);
  assert.match(route, /"Content-Disposition": `attachment; filename=/);
  assert.match(route, /"X-Content-Type-Options": "nosniff"/);
  assert.match(route, /throttlePublic\("secure-file", token, SIGNING_READ_POLICY\)/);
  // Counted after the response: a failed count never costs the customer the file.
  assert.match(route, /after\(\(\) =>\s*withTokenTenantScope\(/);

  const page = src("src/app/f/[token]/page.tsx");
  assert.match(page, /<form method="post" action=\{`\/api\/f\/\$\{token\}`\}>/);
  assert.doesNotMatch(page, /openStoredFile|readFile|recordSecureDownload|storedRef/, "opening the page reads no file and counts nothing");
  assert.match(page, /This file was withdrawn/);
  assert.match(page, /This link has expired/);
  assert.doesNotMatch(page, /Denago/i, "the workspace's own name, never a hard-coded one");
  assert.match(page, /brandForTenant\(link\.tenantId\)/);
});

test("the read receipt is decided by the database, and nothing about the device is kept", () => {
  const store = src("src/lib/secureLinkStore.ts");
  assert.match(store, /updateMany\(\{ where: \{ id, tenantId, firstOpenedAt: null \}, data: \{ firstOpenedAt: now \} \}\)\)\.count === 1/);
  assert.match(store, /if \(!first\) return;/);
  assert.match(store, /\{ tenantId, userId: row\.createdById \}/, "only whoever sent it is told");
  const model = src("prisma/schema.prisma").split("model SecureFileLink {")[1].split("\n}")[0];
  assert.doesNotMatch(model, /\b(ip|ipAddress|userAgent|device)\b/i);
  // What staff see never includes where the file is stored or the link's hash.
  const panelSelect = store.slice(store.indexOf("export async function secureLinksFor"));
  assert.doesNotMatch(panelSelect, /storedRef|token/);
});

test("recall is the caller's permission AND the row's workspace AND the record's access", () => {
  const actions = src("src/app/actions/emails.ts");
  const recall = actions.slice(actions.indexOf("export async function recallSecureLink"), actions.indexOf("export async function sendEmailAction"));
  assert.match(recall, /requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/);
  assert.match(recall, /findFirst\(\{ where: \{ id: String\(id\), tenantId \}/);
  assert.match(recall, /if \(link\.contactId && !\(await canAccessContact\(user, link\.contactId\)\)\)/);
  assert.match(recall, /if \(link\.leadId && !\(await canAccessLead\(user, link\.leadId\)\)\)/);
  assert.match(recall, /updateMany\(\{ where: \{ id: link\.id, tenantId, revokedAt: null \}/);
  assert.match(recall, /logAudit\(\{ action: "secure_link\.recalled"/);
  assert.match(src("src/components/SecureLinkRecall.tsx"), /<ConfirmActionDialog/, "asked first, in the app's own dialog");
});

test("sending as secure links attaches nothing, and a failed send leaves no working link", () => {
  const actions = src("src/app/actions/emails.ts");
  const send = actions.slice(actions.indexOf("export async function sendEmailAction"), actions.indexOf("export async function sendTestEmail"));
  assert.match(send, /if \(asSecureLinks\) \{\s*secureFiles\.push\(\{ fileName: v\.fileName, storedRef: v\.storedName,/);
  assert.match(send, /if \(asSecureLinks\) secureUploads\.push\(/);
  assert.match(send, /messageHtml = bodyHtml \+ secureLinksHtml\(lines, expiresLabel\);/);
  assert.match(send, /url: `\$\{origin\}\/f\/\$\{link\.token\}`/);
  assert.match(send, /if \(secure && sendingTenantId\) await discardSecureLinks\(sendingTenantId, links\.map\(\(link\) => link\.id\)\)/);
  assert.ok(send.indexOf("discardSecureLinks(") < send.indexOf("prisma.communication.create("), "discarded on the failure path, before anything is filed");
  assert.match(send, /attachSecureLinksToEmail\(sendingTenantId, links\.map\(\(link\) => link\.id\), sent\.id\)/);
  // The check comes before any file is stored or any link is made.
  assert.ok(send.indexOf("if (warning && !confirmed)") < send.indexOf("saveFile("));
  assert.ok(send.indexOf("if (warning && !confirmed)") < send.indexOf("createSecureLinks("));
});

test("the table is isolated per workspace, additively", () => {
  const sql = src("prisma/migrations/20261011160000_secure_file_links/migration.sql");
  assert.match(sql, /ALTER TABLE "SecureFileLink" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "SecureFileLink" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /CREATE POLICY "SecureFileLink_tenant_isolation" ON "SecureFileLink"/);
  assert.match(sql, /"tenantId" TEXT NOT NULL,/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|UPDATE "/i);
});

/* ── The check before sending ─────────────────────────────────────────────── */

test("an ID number needs 13 digits, a real birth date and the right check digit", () => {
  assert.ok(isSaIdNumber(SA_ID));
  assert.ok(isSaIdNumber(`${SA_ID.slice(0, 6)} ${SA_ID.slice(6, 10)} ${SA_ID.slice(10)}`), "as people type it, with spaces");
  assert.equal(isSaIdNumber(SA_ID.slice(0, 12) + ((Number(SA_ID[12]) + 1) % 10)), false, "wrong check digit");
  assert.equal(isSaIdNumber("8013015009087"), false, "month 13");
  assert.equal(isSaIdNumber("1234567890123"), false, "a 13-digit number that is not an ID");
  assert.equal(isSaIdNumber("0821234567"), false, "a phone number");
});

test("a card number passes Luhn and starts like a card; other long numbers do not", () => {
  assert.ok(isCardNumber(CARD));
  assert.ok(isCardNumber("4111 1111 1111 1111"));
  assert.equal(isCardNumber("4111111111111112"), false);
  assert.equal(isCardNumber("0000000000000000"), false);
  assert.equal(isCardNumber("1111111111111117"), false, "does not start like a card");
});

test("what is found is named by kind — the number itself never appears", () => {
  const found = sensitiveFindings(`Hi, my ID is ${SA_ID} and card ${CARD}. Account number: 62 1234 5678 9, branch code 250655.`, ["ID copy.pdf", "Brochure.pdf"]);
  assert.deepEqual(found.map((f) => f.kind).sort(), ["bank-account", "card", "file-name", "sa-id"]);
  const said = JSON.stringify(found);
  assert.ok(!said.includes(SA_ID) && !said.includes(CARD) && !said.includes("621234"), "no number is carried in a finding");
});

test("ordinary emails are left alone", () => {
  for (const ordinary of [
    "Hi Thabo, your quote Q-2026 for R 249 900,00 is attached. Call me on 082 123 4567.",
    "VIN AHT1234567890123 and order 1234567890123, delivered 2026-11-10.",
    "The account manager will phone you. Our switchboard is 021 555 0100.",
    "Tracking number 9876543210987, invoice 000123456.",
  ]) assert.deepEqual(sensitiveFindings(ordinary), [], ordinary);
});

test("file names that say what is inside are noticed; ordinary ones are not", () => {
  for (const name of ["ID copy.pdf", "Thabo_ID.jpg", "passport-scan.png", "Bank Statement Oct.pdf", "payslip_sept.pdf", "Proof of address.pdf", "FICA docs.zip", "drivers licence.jpeg"]) assert.ok(looksSensitiveFile(name), name);
  for (const name of ["Quote Q-2026.pdf", "Brochure.pdf", "Video.mp4", "Rapid response.pdf", "Bridge spec.pdf", "Valid until.docx"]) assert.equal(looksSensitiveFile(name), false, name);
});

test("recipients are compared with the addresses on the customer's record", () => {
  assert.deepEqual(recipientsOffRecord("Thabo@Example.co.za", ["thabo@example.co.za"]), []);
  assert.deepEqual(recipientsOffRecord("thabo@example.co.za, broker@other.co.za", ["thabo@example.co.za"]), ["broker@other.co.za"]);
  assert.deepEqual(recipientsOffRecord("someone@example.co.za", []), ["someone@example.co.za"], "no record means nobody is vouched for");
  assert.deepEqual(recipientsOffRecord("a@x.co.za", [null, "", undefined]), ["a@x.co.za"]);
});

test("the sender is stopped only when something sensitive is headed off the record", () => {
  const base = { subject: "Your documents", bodyText: `ID number ${SA_ID}`, fileNames: [], secureLinks: false, customerAddresses: ["thabo@example.co.za"] };
  // To the customer's own address: no warning.
  assert.equal(sendWarning({ ...base, to: "thabo@example.co.za" }), null);
  // To someone else: warned, in words, without the number.
  const warned = sendWarning({ ...base, to: "broker@other.co.za" });
  assert.ok(warned);
  assert.match(warned!.text, /This email has an ID number, and it is going to broker@other\.co\.za, which is not the address on this customer's record\./);
  assert.ok(!warned!.text.includes(SA_ID));
  assert.deepEqual(warned!.kinds, ["sa-id"]);
  // Nothing sensitive, wherever it goes: no warning.
  assert.equal(sendWarning({ ...base, bodyText: "See you Friday.", to: "broker@other.co.za" }), null);
  // No customer record at all: the wording says so.
  assert.match(sendWarning({ ...base, customerAddresses: [], to: "x@y.co.za" })!.text, /not an address on any customer record here/);
  // In the subject line counts too.
  assert.ok(sendWarning({ ...base, bodyText: "", subject: `ID ${SA_ID}`, to: "broker@other.co.za" }));
});

test("a personal document to an unfamiliar address warns — as an attachment AND as a secure link", () => {
  const base = { subject: "Docs", bodyText: "As requested.", fileNames: ["ID copy.pdf"], to: "broker@other.co.za", customerAddresses: ["thabo@example.co.za"] };
  const attached = sendWarning({ ...base, secureLinks: false })!;
  assert.match(attached.text, /an attachment that looks like a personal document \(“ID copy\.pdf”\)/);
  assert.doesNotMatch(attached.text, /secure link/);
  // A link can be recalled, but the wrong person can download it first: still asked, and told why.
  const linked = sendWarning({ ...base, secureLinks: true })!;
  assert.ok(linked, "a secure link does not vouch for the address");
  assert.deepEqual(linked.kinds, ["file-name"]);
  assert.match(linked.text, /going to broker@other\.co\.za/);
  assert.match(linked.text, /can be recalled, but it does not check who opens it/);
  // To the customer's own address: no warning either way.
  assert.equal(sendWarning({ ...base, secureLinks: true, to: "thabo@example.co.za" }), null);
  assert.equal(sendWarning({ ...base, secureLinks: false, to: "thabo@example.co.za" }), null);
  // A number typed in the message is warned about too, without the link sentence (no file is involved).
  assert.ok(sendWarning({ ...base, secureLinks: true, bodyText: `ID ${SA_ID}` }));
  assert.doesNotMatch(sendWarning({ ...base, fileNames: [], secureLinks: true, bodyText: `ID ${SA_ID}` })!.text, /secure link/);
  // The nudge while composing: shown for an attachment, gone once it is a secure link.
  assert.match(secureLinkHint(["ID copy.pdf", "Brochure.pdf"], false) ?? "", /“ID copy\.pdf” looks like a personal document/);
  assert.equal(secureLinkHint(["ID copy.pdf"], true), null);
  assert.equal(secureLinkHint(["Brochure.pdf"], false), null);
});

test("A FLAGGED NUMBER NEVER REACHES THE AUDIT ENTRY: the subject and file names are redacted", () => {
  assert.equal(redactSensitive(`ID ${SA_ID} for Thabo`), "ID [number removed] for Thabo");
  assert.equal(redactSensitive(`Card ${CARD}`), "Card [number removed]");
  assert.equal(redactSensitive("Card 4111 1111 1111 1111 on file"), "Card [number removed] on file");
  assert.equal(redactSensitive("Account number: 1234567890 at FNB"), "Account number: [number removed] at FNB");
  assert.equal(redactSensitive(`ID copy ${SA_ID}.pdf`), "ID copy [number removed].pdf", "a file name too");
  // Whatever the check flags, the redaction removes: no flagged number survives it.
  for (const text of [`ID ${SA_ID}`, `pay with ${CARD}`, "acc no 62123456789", `${SA_ID} and ${CARD}`]) {
    assert.ok(sensitiveFindings(text).length > 0, text);
    assert.deepEqual(sensitiveFindings(redactSensitive(text)), [], text);
    assert.ok(!redactSensitive(text).includes(SA_ID) && !redactSensitive(text).includes(CARD));
  }
  // Ordinary numbers are left alone: a quote number, a phone number, an order number.
  for (const text of ["Quote Q-1022 for you", "Call 082 123 4567", "Order 1234567890123"]) assert.equal(redactSensitive(text), text);
  // …and the audit entry is built from the redacted subject and file names — never the raw ones.
  const actions = src("src/app/actions/emails.ts");
  const audit = actions.slice(actions.indexOf('action: "email.sent"'), actions.indexOf("export async function sendTestEmail"));
  assert.match(audit, /summary: `Sent email to \$\{to\}: “\$\{redactSensitive\(subject\)\}”/);
  assert.match(audit, /redactSensitive\(attachedNames\.join\(", "\)\)/);
  assert.doesNotMatch(audit, /\$\{subject\}|\$\{attachedNames/, "the raw subject or names must not be in the summary");
});

test("A SECURE LINK IS ONLY MADE WHERE FILES ARE STORED PRIVATELY", () => {
  const storage = src("src/lib/storage.ts");
  assert.match(storage, /export const storesPrivately = \(\) => privateMode\(\) \|\| !publicToken\(\);/);
  assert.match(storage, /export const isPublicBlobRef = \(ref: string\) => isTrustedBlobRef\(ref\) && !isPrivateBlobRef\(ref\);/);
  const actions = src("src/app/actions/emails.ts");
  const send = actions.slice(actions.indexOf("export async function sendEmailAction"), actions.indexOf("export async function sendTestEmail"));
  // Refused before the check, before anything is stored, before anything is sent.
  const refuse = send.indexOf("if (secure && !storesPrivately()) return { error: NO_PRIVATE_STORE };");
  assert.ok(refuse > 0);
  assert.ok(refuse < send.indexOf("await saveFile(") && refuse < send.indexOf("await sendEmail("));
  // A library file still in the public store is copied into the private one, not pointed at.
  assert.match(send, /if \(asSecureLinks && isPublicBlobRef\(v\.storedName\)\) \{[\s\S]*?secureUploads\.push\(\{ name: v\.fileName,[\s\S]*?continue;/);
  // The composer is told before the form is submitted, so nothing typed is lost.
  const check = actions.slice(actions.indexOf("export async function checkComposerEmail"), actions.indexOf("export async function recallSecureLink"));
  assert.match(check, /if \(input\.secureLinks && !storesPrivately\(\)\) return \{ warning: null, error: NO_PRIVATE_STORE \};/);
  assert.match(src("src/components/EmailComposer.tsx"), /if \(blocked\) \{[\s\S]*?setPreviewError\(blocked\);\s*return;/);
});

test("the server refuses an unconfirmed send, the composer asks first, and the audit names the kind only", () => {
  const actions = src("src/app/actions/emails.ts");
  const send = actions.slice(actions.indexOf("export async function sendEmailAction"), actions.indexOf("export async function sendTestEmail"));
  assert.match(send, /const confirmed = formData\.get\("sensitiveOk"\) === "1";\s*if \(warning && !confirmed\) \{\s*return \{ error:/);
  assert.match(send, /sent after a sensitive-data warning \(\$\{warning\.kinds\.join\(", "\)\}\)/);
  // The addresses compared against come only from records the caller may open.
  const addresses = actions.slice(actions.indexOf("async function customerAddresses"), actions.indexOf("export async function checkComposerEmail"));
  assert.match(addresses, /contactId && \(await canAccessContact\(user, contactId\)\)/);
  assert.match(addresses, /leadId && \(await canAccessLead\(user, leadId\)\)/);
  const check = actions.slice(actions.indexOf("export async function checkComposerEmail"), actions.indexOf("export async function recallSecureLink"));
  assert.match(check, /requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/);
  assert.match(check, /return \{ warning: warning\?\.text \?\? null \};/, "words only — never the findings' raw text");

  const composer = src("src/components/EmailComposer.tsx");
  assert.match(composer, /<form ref=\{formRef\} action=\{formAction\} onSubmit=\{onSubmit\}/);
  assert.match(composer, /event\.preventDefault\(\);/);
  assert.match(composer, /<input ref=\{confirmedRef\} type="hidden" name="sensitiveOk" defaultValue="" \/>/);
  assert.match(composer, />Send anyway</);
  assert.match(composer, />Go back and change it</);
  assert.doesNotMatch(composer, /window\.confirm|confirm\(/, "never a browser dialog");
});
