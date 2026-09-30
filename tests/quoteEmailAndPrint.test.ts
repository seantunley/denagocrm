import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  DEFAULT_QUOTE_EMAIL,
  composeQuoteEmail,
  deliverQuoteEmail,
  quoteEmailVars,
  quotePdfFileName,
} from "../src/lib/quoteEmail";
import { quotePrintLinks } from "../src/lib/quotePrintLinks";

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
      record: async () => {
        calls.push("record");
      },
    },
  };
}

const mail = { to: "a@b.co", subject: "s", body: "b", fileName: quotePdfFileName(7) };

test("status changes only AFTER a successful send", async () => {
  const f = fakes({});
  const result = await deliverQuoteEmail(mail, f.deps);
  assert.deepEqual(result, { ok: true, markedSent: true });
  assert.deepEqual(f.calls, ["pdf", "send", "markSent", "record"]);
});

test("a failed send is reported and the quote is NOT marked sent or logged", async () => {
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
  assert.doesNotMatch(draft, /sendEmail|deliverQuoteEmail|quote\.updateMany|communication\.create/);
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

test("the send lands on the customer's timeline", () => {
  const action = shipped("src/app/actions/quoteEmail.ts");
  assert.match(action, /communication\.create\(\{[\s\S]*type: "email",\s*direction: "outbound"/);
  assert.match(action, /tenantId: await customerRecordTenantId\(/);
  assert.match(action, /action: "quote\.emailed"/);
});

/* ── No company baked in ──────────────────────────────────────────────────── */

test("the email names the workspace from its settings, never a literal", () => {
  const vars = quoteEmailVars({ customerName: "Thandi Mokoena", quoteNumber: 42, total: "R 1 000,00", companyName: "Acme Carts", senderName: "Pat" });
  const out = composeQuoteEmail(null, vars);
  assert.equal(out.subject, "Your quote Q-42 from Acme Carts");
  assert.match(out.body, /^Hi Thandi,/);
  assert.match(out.body, /Pat$/);
  // A chosen template wins over the default.
  assert.equal(composeQuoteEmail({ subject: "{{quote_number}} for {{name}}", body: "x" }, vars).subject, "Q-42 for Thandi Mokoena");

  for (const file of ["src/lib/quoteEmail.ts", "src/app/actions/quoteEmail.ts", "src/components/quotes/QuoteEmailDialog.tsx"]) {
    assert.doesNotMatch(shipped(file), /denago|073\s?789|maitland|cape town/i, file);
  }
  assert.doesNotMatch(JSON.stringify(DEFAULT_QUOTE_EMAIL), /denago/i);
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
  assert.match(quotes, /id: \{ in: accessibleQuoteIds \}/);
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
