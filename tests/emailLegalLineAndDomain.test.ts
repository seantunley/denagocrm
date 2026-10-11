import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { LEGAL_LINE_MAX, cleanLegalLine, htmlWithLegalLine, textWithLegalLine } from "../src/lib/emailLegalLine";
import { assessSendingDomain, sendingDomainOf, sendingDomainVerdict } from "../src/lib/sendingDomain";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/* ── The legal line ───────────────────────────────────────────────────────── */

test("no legal line set leaves an email exactly as it was", () => {
  const html = "<html><body><p>Hello</p></body></html>";
  assert.equal(htmlWithLegalLine(html, ""), html);
  assert.equal(htmlWithLegalLine(html, "   "), html);
  assert.equal(textWithLegalLine("Hello", ""), "Hello");
});

test("the legal line goes at the foot of the HTML and the plain text, once, escaped", () => {
  const line = "Example Motors (Pty) Ltd · Reg. no. 2019/123456/07 <b>";
  const html = htmlWithLegalLine("<html><body><p>Hello</p><img src='pixel'/></body></html>", line);
  assert.ok(html.indexOf("Reg. no. 2019/123456/07") > html.indexOf("pixel"), "after everything else");
  assert.ok(html.indexOf("Reg. no. 2019/123456/07") < html.indexOf("</body>"));
  assert.match(html, /&lt;b&gt;/, "what the owner typed is text, never markup");
  assert.equal(htmlWithLegalLine(html, line), html, "a preview that already has it does not get it twice");
  assert.equal(textWithLegalLine("Hello", line), `Hello\n\n${line}`);
  assert.equal(textWithLegalLine(`Hello\n\n${line}`, line), `Hello\n\n${line}`);
  assert.match(htmlWithLegalLine("<p>no body tag</p>", "Reg 1"), /<p>no body tag<\/p><!--legal-line-->/);
});

test("the legal line is one bounded line", () => {
  assert.equal(cleanLegalLine("  Reg\n no.\t 1  "), "Reg no. 1");
  assert.equal(cleanLegalLine("x".repeat(LEGAL_LINE_MAX + 50)).length, LEGAL_LINE_MAX);
  assert.equal(cleanLegalLine(null), "");
});

test("the legal line is added where every email leaves, shown in the preview, and only the owner sets it", () => {
  const email = src("src/lib/email.ts");
  assert.match(email, /const legalLine = await getSetting\(LEGAL_LINE_KEY\)\.catch\(\(\) => null\);/);
  assert.match(email, /const untracked = input\.html && legalLine \? htmlWithLegalLine\(input\.html, legalLine\) : input\.html;/);
  // A tracking failure falls back to the email WITH its legal line, not without.
  assert.match(email, /openToken = undefined;\s*html = untracked;/);
  assert.match(email, /subject: input\.subject,\s*text,\s*html: inline\?\.html \?\? html,/);
  const composer = src("src/app/actions/emails.ts");
  assert.match(composer, /const legalLine = preview \? await getSetting\(LEGAL_LINE_KEY\)\.catch\(\(\) => null\) : null;/, "preview only — the sender adds it for a real send");
  const actions = src("src/app/actions/signatureBanners.ts");
  const save = actions.slice(actions.indexOf("export async function saveEmailLegalLine"), actions.indexOf("export async function setMarketingBannerActive"));
  assert.match(save, /await workspace\(\)/);
  assert.match(save, /logAudit\(/);
  // Not marketing: it is not routed through the opt-out door at all.
  assert.doesNotMatch(src("src/lib/emailLegalLine.ts"), /marketingOptOut|bannerForEmail/);
});

/* ── The sending-domain check ─────────────────────────────────────────────── */

const check = (over: Partial<Parameters<typeof assessSendingDomain>[0]>) =>
  assessSendingDomain({ domain: "example.co.za", txt: [], dmarc: [], dkimSelector: null, smtpHost: "mail.example.co.za", ...over });
const state = (checks: ReturnType<typeof check>, key: string) => checks.find((c) => c.key === key)?.state;

test("the sending domain is read from the From address, or the mailbox login", () => {
  assert.equal(sendingDomainOf('"Example Motors" <Sales@Example.co.za>'), "example.co.za");
  assert.equal(sendingDomainOf("Example Motors", "crm@mail.example.co.za"), "mail.example.co.za");
  assert.equal(sendingDomainOf("Example Motors", ""), null);
});

test("a domain with nothing set up is told so, with what to do", () => {
  const checks = check({});
  assert.equal(state(checks, "spf"), "bad");
  assert.equal(state(checks, "dmarc"), "bad");
  assert.match(checks.find((c) => c.key === "dmarc")!.fix, /_dmarc\.example\.co\.za/);
  assert.match(checks.find((c) => c.key === "spf")!.fix, /mail\.example\.co\.za/);
  assert.equal(sendingDomainVerdict(checks).state, "bad");
  assert.match(sendingDomainVerdict(checks).text, /SPF and DMARC need fixing/);
});

test("DKIM not found is 'can't tell', never 'broken'", () => {
  const checks = check({ txt: ["v=spf1 include:_spf.example.net -all"], dmarc: ["v=DMARC1; p=reject"] });
  assert.equal(state(checks, "dkim"), "unknown");
  assert.match(checks.find((c) => c.key === "dkim")!.meaning, /does not mean there is none/);
  assert.equal(sendingDomainVerdict(checks).state, "unknown");
  const found = check({ txt: ["v=spf1 include:_spf.example.net ~all"], dmarc: ["v=DMARC1; p=quarantine; rua=mailto:x@example.co.za"], dkimSelector: "google" });
  assert.deepEqual(found.map((c) => c.state), ["good", "good", "good"]);
  assert.equal(sendingDomainVerdict(found).state, "good");
});

test("SPF is judged on what the record actually says", () => {
  assert.equal(state(check({ txt: ["v=spf1 mx -all", "v=spf1 a ~all"] }), "spf"), "bad", "two records count as none");
  assert.equal(state(check({ txt: ["v=spf1 +all"] }), "spf"), "bad", "anyone may send");
  assert.equal(state(check({ txt: ["v=spf1 all"] }), "spf"), "bad", "a bare all is +all");
  assert.equal(state(check({ txt: ["v=spf1 mx ?all"] }), "spf"), "warn");
  assert.equal(state(check({ txt: ["v=spf1 mx"] }), "spf"), "warn", "no ending at all");
  assert.equal(state(check({ txt: ["v=spf1 redirect=_spf.example.net"] }), "spf"), "good", "handed over to another record");
  assert.equal(state(check({ txt: ["google-site-verification=abc", "v=spf1 mx ~all"] }), "spf"), "good", "other TXT records are ignored");
  // It never claims the record names the right server — it cannot know.
  assert.match(check({ txt: ["v=spf1 mx -all"] }).find((c) => c.key === "spf")!.meaning, /cannot tell whether it names mail\.example\.co\.za/);
});

test("DMARC watching-only is a warning, enforcing is good, and no policy is broken", () => {
  assert.equal(state(check({ dmarc: ["v=DMARC1; p=none; rua=mailto:x@example.co.za"] }), "dmarc"), "warn");
  assert.equal(state(check({ dmarc: ["v=DMARC1;p=reject"] }), "dmarc"), "good");
  assert.equal(state(check({ dmarc: ["v=DMARC1; rua=mailto:x@example.co.za"] }), "dmarc"), "bad");
  assert.equal(state(check({ dmarc: ["v=DMARC1; p=none", "v=DMARC1; p=reject"] }), "dmarc"), "bad");
  // sp= (the subdomain policy) is not mistaken for p=.
  assert.equal(state(check({ dmarc: ["v=DMARC1; sp=reject; p=none"] }), "dmarc"), "warn");
});

test("the check is owner-only, read-only, and a failed lookup is never reported as a missing record", () => {
  const action = src("src/app/actions/sendingDomain.ts");
  assert.match(action, /await requireTenantOwner\(\);/);
  assert.match(action, /return code === "ENOTFOUND" \|\| code === "ENODATA" \? \[\] : null;/);
  assert.match(action, /if \(root === null \|\| dmarc === null\) return \{ ok: false as const, error: "The lookup did not get an answer\. Try again in a minute\." \};/);
  assert.doesNotMatch(action, /prisma\.|putSetting|sendEmail/, "it reads DNS and nothing else");
  assert.match(src("src/app/(app)/settings/page.tsx"), /\{setting\("SMTP_HOST"\) && <SendingDomainCheck \/>\}/);
});
