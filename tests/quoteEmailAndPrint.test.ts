import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { deliverQuoteEmail, quotePdfFileName } from "../src/lib/quoteEmail";
import { quotePrintLinks } from "../src/lib/quotePrintLinks";
import {
  SIGNING_EMAILS,
  SIGNING_EMAIL_KINDS,
  parseStoredSigningTemplate,
  renderSigningEmail,
  validateSigningTemplate,
  type SigningEmailBrand,
} from "../src/lib/signing/emailTemplates";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Source with comments stripped, so a comment describing a rule can't satisfy it. */
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function body(source: string, name: string): string {
  const start = source.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n\s*(export )?(async )?function /);
  return next === -1 ? rest : rest.slice(0, next);
}

/* ── #14 Email quote: the send order ─────────────────────────────────────── */

function fakes(opts: { pdf?: Buffer | null; sendOk?: boolean }) {
  const calls: string[] = [];
  let attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  return {
    calls,
    attachments: () => attachments,
    deps: {
      renderPdf: async () => {
        calls.push("pdf");
        return opts.pdf === undefined ? Buffer.from("%PDF-1.7") : opts.pdf;
      },
      send: async (mail: { attachments: typeof attachments }) => {
        calls.push("send");
        attachments = mail.attachments;
        return opts.sendOk === false ? { ok: false, error: "SMTP said no" } : { ok: true };
      },
      markSentIfDraft: async () => {
        calls.push("markSent");
        return true;
      },
      audit: async () => {
        calls.push("audit");
      },
    },
  };
}

const mail = { to: "a@b.co", fileName: quotePdfFileName(7) };

test("status changes only AFTER a successful send", async () => {
  const f = fakes({});
  const result = await deliverQuoteEmail(mail, f.deps);
  assert.deepEqual(result, { ok: true, markedSent: true });
  assert.deepEqual(f.calls, ["pdf", "send", "markSent", "audit"]);
});

test("a failed send is reported and the quote is NOT marked sent or audited", async () => {
  const f = fakes({ sendOk: false });
  const result = await deliverQuoteEmail(mail, f.deps);
  assert.deepEqual(result, { ok: false, error: "SMTP said no" });
  assert.deepEqual(f.calls, ["pdf", "send"]);
});

test("no PDF, no email", async () => {
  const f = fakes({ pdf: null });
  const result = await deliverQuoteEmail(mail, f.deps);
  assert.equal(result.ok, false);
  assert.deepEqual(f.calls, ["pdf"]);
});

test("the quote PDF is attached", async () => {
  const f = fakes({});
  await deliverQuoteEmail(mail, f.deps);
  assert.deepEqual(
    f.attachments().map((a) => [a.filename, a.contentType, a.content.toString()]),
    [["Quote-Q-7.pdf", "application/pdf", "%PDF-1.7"]],
  );
});

test("the PDF comes from the Print / PDF renderer", () => {
  const action = shipped("src/app/actions/quoteEmail.ts");
  const route = shipped("src/app/(print)/quotes/[id]/print/route.ts");
  assert.match(route, /renderQuotePrintHtml\(/);
  assert.match(action, /renderQuotePrintHtml\(\{ quoteId \}\)/);
  assert.match(action, /htmlToPdf\(html\)/);
});

test("nothing is sent without the explicit Send click", () => {
  const action = shipped("src/app/actions/quoteEmail.ts");
  // Opening the dialog only drafts.
  const draft = body(action, "quoteEmailDraft");
  assert.doesNotMatch(draft, /sendEmail|deliverQuoteEmail|quote\.updateMany|logAudit/);
  // The only path to sendEmail is sendQuoteEmail → deliverQuoteEmail.
  assert.equal((action.match(/sendEmail\(/g) ?? []).length, 1);
  assert.match(body(action, "sendQuoteEmail"), /deliverQuoteEmail\(/);

  const dialog = shipped("src/components/quotes/QuoteEmailDialog.tsx");
  assert.doesNotMatch(body(dialog, "openDialog"), /sendQuoteEmail/);
  assert.equal((dialog.match(/sendQuoteEmail\(/g) ?? []).length, 1, "one call site: send()");
  assert.match(body(dialog, "send"), /sendQuoteEmail\(/);
  assert.match(dialog, /onClick=\{send\}/);
  // No auto-send on open or mount.
  assert.doesNotMatch(dialog, /useEffect/);
});

test("emailing a quote needs what every other send of a quote needs", () => {
  const action = shipped("src/app/actions/quoteEmail.ts");
  const gate = body(action, "emailingUser");
  assert.match(gate, /hasPermission\(user, "quotes\.change_status"\)/);
  assert.match(gate, /canAccessQuote\(user, quoteId\)/);
  assert.match(body(action, "quoteEmailDraft"), /await emailingUser\(quoteId\)/);
  assert.match(body(action, "sendQuoteEmail"), /await emailingUser\(quoteId\)/);
  // The sibling it mirrors.
  assert.match(shipped("src/app/actions/quotes.ts"), /requireQuoteAccess\(quoteId, "quotes\.change_status"\)/);
  // Only a draft moves to sent.
  assert.match(action, /status: "draft",\s*updatedAt: quote\.updatedAt/);
});

test("the send lands on the customer's timeline through sendEmail's shared record", () => {
  const action = shipped("src/app/actions/quoteEmail.ts");
  assert.match(action, /record: \{ contactId: quote\.contactId, leadId: quote\.leadId, userId: user\.id, label: "Quote email" \}/);
  assert.doesNotMatch(action, /communication\.create/, "no hand-written Communication row");
  assert.doesNotMatch(readFileSync(path.join(root, "src/app/actions/quoteEmail.ts"), "utf8"), /TODO\(#694\)/);
  assert.match(action, /action: "quote\.emailed"/);
});

/* ── The Quote email template: one more kind of the signing-email editor ── */

const BRAND: SigningEmailBrand = {
  companyName: "Acme Carts",
  tagline: null,
  logoUrl: null,
  accent: "#123abc",
  accentText: "#ffffff",
  phone: "021 555 0000",
  email: "hello@acme.test",
};
const VARS = {
  recipient_name: "Thandi Mokoena",
  first_name: "Thandi",
  document_title: "Quote Q-42",
  quote_number: "Q-42",
  total: "R 1 000,00",
  company_name: "Acme Carts",
  sender_name: "Pat",
};

test("Quote email is edited in Settings → Email templates beside the signing emails", () => {
  assert.ok(SIGNING_EMAIL_KINDS.includes("quote"), "the settings loop renders every kind");
  const settings = shipped("src/app/(app)/settings/page.tsx");
  // Rendered section by section (each kind's group), so every kind still appears.
  assert.match(settings, /SIGNING_EMAIL_KINDS\.filter\(\(k\) => SIGNING_EMAILS\[k\]\.group === group\)\.map\(\(kind\) =>/);
  assert.match(settings, /saveSigningEmailTemplate\.bind\(null, kind\)/);
  assert.match(settings, /resetSigningEmailTemplate\.bind\(null, kind\)/);
  // The two-step picker is gone.
  assert.doesNotMatch(settings, /QUOTE_EMAIL_TEMPLATE|saveQuoteEmailSettings/);
  assert.doesNotMatch(shipped("src/app/actions/emails.ts"), /QUOTE_EMAIL_TEMPLATE|saveQuoteEmailSettings/);
});

test("default Quote email: merge fields filled, no company literal, passes its own validation", () => {
  const def = SIGNING_EMAILS.quote;
  assert.equal(validateSigningTemplate("quote", def.subject, def.body), null);
  const e = renderSigningEmail("quote", null, VARS, BRAND);
  assert.equal(e.subject, "Your quote Q-42 from Acme Carts");
  assert.match(e.text, /^Hi Thandi,/);
  assert.match(e.text, /Kind regards,\nPat\nAcme Carts$/);
  assert.doesNotMatch(e.html, /Open &amp; sign/, "no signing button on a quote email");
  for (const file of ["src/lib/quoteEmail.ts", "src/app/actions/quoteEmail.ts", "src/components/quotes/QuoteEmailDialog.tsx"]) {
    assert.doesNotMatch(shipped(file), /denago|073\s?789|maitland|cape town/i, file);
  }
  assert.doesNotMatch(def.subject + def.body, /denago/i);
});

test("an edited template round-trips: validated, stored as JSON, rendered back", () => {
  const subject = "{{quote_number}} for {{first_name}} — {{total}}";
  const text = "Morning {{recipient_name}},\n\nHere it is.\n\n{{sender_name}}";
  assert.equal(validateSigningTemplate("quote", subject, text), null);
  const stored = parseStoredSigningTemplate(JSON.stringify({ subject, body: text }));
  assert.deepEqual(stored, { subject, body: text });
  const e = renderSigningEmail("quote", stored, VARS, BRAND);
  assert.equal(e.subject, "Q-42 for Thandi — R 1 000,00");
  assert.equal(e.text, "Morning Thandi Mokoena,\n\nHere it is.\n\nPat");
  // Reset = the stored row deleted → parse(null) → default wording.
  assert.equal(parseStoredSigningTemplate(null), null);
  assert.equal(renderSigningEmail("quote", null, VARS, BRAND).subject, "Your quote Q-42 from Acme Carts");
  // Only this kind's fields; signing secrets are not quote fields.
  assert.match(validateSigningTemplate("quote", "Hi", "{{signing_link}}") ?? "", /Unknown field/);
});

test("typed text and customer values are HTML-escaped; CR/LF never reaches the subject", () => {
  const evil = { ...VARS, recipient_name: `<img src=x onerror=alert(1)> & "Co"` };
  const e = renderSigningEmail("quote", { subject: "Quote\r\nBcc: x@evil.test {{first_name}}", body: "<b>Hi</b> {{recipient_name}}" }, evil, BRAND);
  assert.doesNotMatch(e.html, /<img src=x|<b>Hi/);
  assert.match(e.html, /&lt;b&gt;Hi&lt;\/b&gt; &lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Co&quot;/);
  assert.doesNotMatch(e.subject, /[\r\n]/);
  // The per-send edit takes the same validation as the saved template.
  assert.match(body(shipped("src/app/actions/quoteEmail.ts"), "sendQuoteEmail"), /validateSigningTemplate\("quote", subject, body\)/);
});

/* ── Tenant scoping: the QUOTE's tenant, and only it ──────────────────────── */

const settingsReads: (string | undefined)[] = [];
const STORE = [
  { tenantId: "t_a", key: "QUOTE_EMAIL", value: JSON.stringify({ subject: "A says {{quote_number}}", body: "Tenant A copy for {{first_name}}" }) },
  { tenantId: "t_a", key: "COMPANY_PHONE", value: "011 000 0000" },
];
const fakeDb = {
  appSetting: {
    findMany: async ({ where }: { where: { tenantId?: string; key: { in: string[] } } }) => {
      settingsReads.push(where.tenantId);
      return STORE.filter((r) => r.tenantId === where.tenantId && where.key.in.includes(r.key));
    },
  },
};
const loader = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/db") return { basePrisma: fakeDb, prisma: fakeDb };
  if (request === "@/lib/settings") return { decryptValue: (s: string) => s };
  if (request === "@/lib/emailBrand") return { emailBrand: async () => ({ logoUrl: null }) };
  if (request === "@/lib/tenantBrand") {
    return {
      DEFAULT_BRAND: { tenantId: null, displayName: "CRM", tagline: null, primary: null, primaryForeground: null },
      brandForTenant: async (t: string) => ({ tenantId: t, displayName: t === "t_a" ? "Acme" : "Bravo", tagline: null, primary: null, primaryForeground: null }),
    };
  }
  return realLoad.call(this, request, parent, isMain);
};
const { tenantEmailContent } = createRequire(import.meta.url)(
  "../src/lib/signing/signingEmail.ts",
) as typeof import("../src/lib/signing/signingEmail");

test("the quote email renders from the quote's tenant's template and brand only", async () => {
  const a = await tenantEmailContent("quote", "t_a", VARS);
  assert.equal(a.subject, "A says Q-42");
  assert.equal(a.text, "Tenant A copy for Thandi");
  assert.match(a.html, /011 000 0000/);

  const b = await tenantEmailContent("quote", "t_b", VARS);
  assert.equal(b.subject, "Your quote Q-42 from Bravo", "tenant B has no override → default, never tenant A's");
  assert.doesNotMatch(b.html, /Tenant A|011 000 0000|Acme/);

  const before = settingsReads.length;
  const none = await tenantEmailContent("quote", null, VARS);
  assert.equal(settingsReads.length, before, "no tenant → no settings read for ANY tenant");
  assert.doesNotMatch(none.html, /Tenant A|011 000 0000/);
  assert.deepEqual(settingsReads, ["t_a", "t_b"]);

  // The per-send edit wins over the stored template, still in the tenant's brand.
  const edited = await tenantEmailContent("quote", "t_a", VARS, { subject: "Edited", body: "Just this once" });
  assert.equal(edited.subject, "Edited");
  assert.match(edited.html, /Just this once[\s\S]*011 000 0000/);

  // The action keys every render on the QUOTE's tenant, never ambient scope.
  const action = shipped("src/app/actions/quoteEmail.ts");
  assert.match(action, /tenantEmailContent\("quote", quote\.tenantId, vars\)/);
  assert.match(action, /tenantEmailContent\("quote", quote\.tenantId, vars, \{ subject, body \}\)/);
  // Saving is per tenant (the generic signing-template action, AppSetting tenantId_key).
  assert.match(body(shipped("src/app/actions/emails.ts"), "saveSigningEmailTemplate"), /tenantId_key: \{ tenantId, key: def\.settingKey \}/);
});

/* ── #13 Print invoice / sales agreement ──────────────────────────────────── */

test("invoice and agreement links appear only for accepted quotes", () => {
  assert.deepEqual(quotePrintLinks({ id: "q1", status: "draft" }), []);
  assert.deepEqual(quotePrintLinks({ id: "q1", status: "sent" }), []);
  assert.deepEqual(quotePrintLinks({ id: "q1", status: "accepted" }).map((l) => l.href), [
    "/quotes/q1/invoice",
    "/quotes/q1/agreement",
  ]);
});

test("print buttons use the same gate as the print routes", () => {
  // The routes: quote view permission + access to THIS quote.
  for (const file of [
    "src/app/(print)/quotes/[id]/invoice/page.tsx",
    "src/app/(print)/quotes/[id]/agreement/page.tsx",
    "src/app/(print)/quotes/[id]/doc/[key]/route.ts",
  ]) {
    assert.match(shipped(file), /await requireQuoteReadAccess\(id\)/, file);
  }
  const perms = shipped("src/lib/permissions.ts");
  assert.match(body(perms, "requireQuoteReadAccess"), /requireAnyPermission\("quotes\.view_all", "quotes\.view_owned"\)[\s\S]*canAccessQuote\(user, quoteId\)/);
  assert.match(body(perms, "canAccessQuote"), /getAccessibleQuoteIds\(user\)/);

  // Every list that renders the links is built from getAccessibleQuoteIds — the
  // set canAccessQuote checks, empty without quote view permission.
  const quotes = shipped("src/app/(app)/quotes/page.tsx");
  assert.match(quotes, /requireAnyPermission\("quotes\.view_all", "quotes\.view_owned"\)/);
  // The list's rows come from quoteListFilter (shared with the CSV export),
  // which scopes them by getAccessibleQuoteIds.
  assert.match(quotes, /const \{ where, all \} = await quoteListFilter\(user, \{ q, status \}\)/);
  assert.match(quotes, /prisma\.quote\.findMany\(\{\s*where,/);
  assert.match(shipped("src/lib/quoteListQuery.ts"), /getAccessibleQuoteIds\(user\)/);
  assert.match(shipped("src/lib/quoteList.ts"), /input\.accessibleIds \? \[\{ id: \{ in: input\.accessibleIds \} \}\]/);
  assert.match(quotes, /quotePrintLinks\(quote\)/);

  const deliveries = shipped("src/app/(app)/deliveries/page.tsx");
  assert.match(deliveries, /getAccessibleQuoteIds\(user\)/);
  assert.match(deliveries, /id: \{ in: quoteIds \}/);
  assert.match(deliveries, /quotePrintLinks\(quote\)/);

  const lead = shipped("src/app/(app)/leads/[id]/page.tsx");
  assert.match(lead, /const printableQuoteIds = await getAccessibleQuoteIds\(user\)/);
  assert.match(lead, /canPrintQuote\(q\.id\) && quotePrintLinks\(q\)/);

  // The editor only ever holds a quote quoteEditorRecord (or the list) let in.
  const editorRecord = body(shipped("src/app/actions/quotes.ts"), "quoteEditorRecord");
  assert.match(editorRecord, /hasAnyPermission\(user, "quotes\.view_all", "quotes\.view_owned"\)/);
  assert.match(editorRecord, /canAccessQuote\(user, id\)/);
  assert.match(shipped("src/components/quotes/QuoteEditorDialog.tsx"), /quotePrintLinks\(\{ id: savedQuote\.id, status: currentStatus \}\)/);
});
