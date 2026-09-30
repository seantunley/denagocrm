import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

import {
  SIGNING_EMAILS,
  renderSigningEmail,
  validateSigningTemplate,
  parseStoredSigningTemplate,
  type SigningEmailBrand,
} from "../src/lib/signing/emailTemplates";

const URL_ = "https://crm.example.co.za/signing/AbCdEf0123456789_-xyz";
const BRAND: SigningEmailBrand = {
  companyName: "Acme Carts",
  tagline: "Golf & leisure",
  logoUrl: "https://crm.example.co.za/api/brand/logo/t_a?a=x",
  accent: "#ea580c",
  accentText: "#ffffff",
  phone: "021 555 0000",
  email: "hello@acme.test",
};
const VARS = {
  recipient_name: "Jane Doe",
  first_name: "Jane",
  document_title: "Quote Q-1026",
  quote_number: "Q-1026",
  company_name: "Acme Carts",
  sender_name: "Sam Sales",
  company_phone: "021 555 0000",
  company_email: "hello@acme.test",
  signing_link: URL_,
  expiry_date: "30 Oct 2026",
  code: "123456",
};

/* ── defaults reproduce today's emails ───────────────────────────────────── */

test("default invitation carries today's wording, link and button", () => {
  const e = renderSigningEmail("invite", null, VARS, BRAND);
  assert.equal(e.subject, "Please sign your document: Quote Q-1026");
  assert.match(e.html, /Hi Jane Doe,/);
  assert.match(e.html, /Please review and sign Quote Q-1026\./);
  assert.match(e.html, /Open &amp; sign/);
  assert.match(e.html, /Or paste this link into your browser:/);
  assert.ok(e.html.includes(`href="${URL_}"`));
  assert.match(e.text, /^Hi Jane Doe,\n\nPlease review and sign Quote Q-1026\.\n\nOpen and sign here:\nhttps:\/\/crm\.example\.co\.za\/signing\//);
  assert.match(e.text, /Thank you,\nAcme Carts$/);
  // Logo on top, brand in the footer.
  assert.ok(e.html.includes(`<img src="${BRAND.logoUrl}"`));
  assert.match(e.html, /Acme Carts — Golf &amp; leisure/);
});

test("default reminder, signed-copy and code emails keep today's subjects", () => {
  assert.equal(renderSigningEmail("reminder", null, VARS, BRAND).subject, "Reminder — please sign: Quote Q-1026");
  const done = renderSigningEmail("completed", null, VARS, BRAND);
  assert.equal(done.subject, "Completed & signed: Quote Q-1026");
  assert.match(done.text, /Everyone has signed "Quote Q-1026"\. The final sealed PDF is attached\./);
  assert.doesNotMatch(done.html, /Open &amp; sign/, "nothing to sign on a signed copy");
  const otp = renderSigningEmail("otp", null, VARS, BRAND);
  assert.equal(otp.subject, "Verification code: Quote Q-1026");
  assert.match(otp.text, /123456/);
  assert.match(otp.html, /123456/);
  assert.match(otp.text, /expires in 10 minutes/);
});

test("no default template names a company by a literal", () => {
  for (const def of Object.values(SIGNING_EMAILS)) {
    assert.doesNotMatch(def.subject + def.body, /Denago/i);
    assert.equal(validateSigningTemplate(def.kind, def.subject, def.body), null, `${def.kind} default must pass its own validation`);
  }
});

/* ── merge fields and escaping ───────────────────────────────────────────── */

test("merge values and template text are HTML-escaped; the text part is not", () => {
  const evil = { ...VARS, recipient_name: `<script>alert(1)</script> & "Co"` };
  const e = renderSigningEmail(
    "invite",
    { subject: "For {{first_name}}", body: "<b>Hi</b> {{recipient_name}} from {{sender_name}}, expires {{expiry_date}}\n\n{{signing_link}}" },
    evil,
    BRAND,
  );
  assert.doesNotMatch(e.html, /<script>|<b>Hi/);
  assert.match(e.html, /&lt;b&gt;Hi&lt;\/b&gt; &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;Co&quot; from Sam Sales, expires 30 Oct 2026/);
  assert.match(e.text, /<b>Hi<\/b> <script>alert\(1\)<\/script> & "Co" from Sam Sales/);
  assert.equal(e.subject, "For Jane");
});

test("only the kind's own fields render; anything else is blank", () => {
  const e = renderSigningEmail(
    "completed",
    { subject: "x {{signing_link}}{{constructor}}", body: "a{{code}}b{{token}}c{{__proto__}}d{{toString}}" },
    VARS,
    BRAND,
  );
  assert.equal(e.subject, "x");
  assert.match(e.text, /^abcd$/);
  assert.doesNotMatch(e.html, /123456|signing\/|function/);
});

test("a link or code never reaches the subject", () => {
  const e = renderSigningEmail("invite", { subject: "Sign {{signing_link}}", body: "{{signing_link}}" }, VARS, BRAND);
  assert.equal(e.subject, "Sign");
  assert.match(validateSigningTemplate("invite", "Sign {{signing_link}}", "{{signing_link}}") ?? "", /can't go in the subject/);
  assert.match(validateSigningTemplate("otp", "Code {{code}}", "{{code}}") ?? "", /can't go in the subject/);
  assert.equal(renderSigningEmail("otp", { subject: "Code {{code}}", body: "{{code}}" }, VARS, BRAND).subject, "Code");
});

test("header injection: CR/LF in a value cannot reach the subject", () => {
  const e = renderSigningEmail("invite", null, { ...VARS, document_title: "Quote\r\nBcc: x@evil.test" }, BRAND);
  assert.doesNotMatch(e.subject, /[\r\n]/);
});

/* ── the link / code cannot be removed ───────────────────────────────────── */

test("saving without the signing link or the code is refused", () => {
  assert.match(validateSigningTemplate("invite", "Hi", "No link here") ?? "", /must include \{\{signing_link\}\}/);
  assert.match(validateSigningTemplate("reminder", "Hi", "No link here") ?? "", /must include \{\{signing_link\}\}/);
  assert.match(validateSigningTemplate("otp", "Hi", "No code here") ?? "", /must include \{\{code\}\}/);
  assert.equal(validateSigningTemplate("completed", "Hi", "No link needed"), null);
});

test("a stored template without the link still sends it (appended)", () => {
  const e = renderSigningEmail("invite", { subject: "Hi", body: "Please sign." }, VARS, BRAND);
  assert.ok(e.html.includes(`href="${URL_}"`));
  assert.match(e.html, /v:roundrect/);
  assert.ok(e.text.endsWith(`Open and sign here:\n${URL_}`));
  const otp = renderSigningEmail("otp", { subject: "Hi", body: "Your code:" }, VARS, BRAND);
  assert.match(otp.text, /123456$/);
});

test("unknown fields and pasted signing links are refused on save", () => {
  assert.match(validateSigningTemplate("invite", "Hi {{token}}", "{{signing_link}}") ?? "", /Unknown field: \{\{token\}\}/);
  assert.match(validateSigningTemplate("completed", "Hi", "{{signing_link}}") ?? "", /Unknown field/);
  assert.match(
    validateSigningTemplate("invite", "Hi", `{{signing_link}}\n\nor ${URL_}`) ?? "",
    /Don't paste a signing link/,
  );
});

test("a malformed stored override falls back to the default", () => {
  assert.equal(parseStoredSigningTemplate("not json"), null);
  assert.equal(parseStoredSigningTemplate(JSON.stringify({ subject: "", body: "x" })), null);
  assert.equal(parseStoredSigningTemplate(null), null);
  assert.deepEqual(parseStoredSigningTemplate(JSON.stringify({ subject: "s", body: "b" })), { subject: "s", body: "b" });
});

/* ── Outlook-safe button ─────────────────────────────────────────────────── */

test("the button is bulletproof: VML for Outlook, bgcolor + padding on a <td> for everyone else", () => {
  const e = renderSigningEmail("invite", null, VARS, { ...BRAND, accent: "#123abc", accentText: "#ffffff" });
  assert.match(e.html, /<!--\[if mso\]>[\s\S]*<v:roundrect[^>]*href="https:\/\/crm\.example\.co\.za\/signing\/[^"]+"[^>]*fillcolor="#123abc"[\s\S]*<!\[endif\]-->/);
  assert.match(e.html, /<!--\[if !mso\]><!-->[\s\S]*<td align="center" bgcolor="#123abc" style="background-color:#123abc;border-radius:8px;padding:13px 26px;">[\s\S]*<!--<!\[endif\]-->/);
  // The old failure: padding ONLY on the <a>, which Outlook ignores.
  assert.doesNotMatch(e.html, /<a [^>]*padding:12px 22px/);
  assert.match(e.html, /<table role="presentation"/);
});

/* ── tenant scoping (the server half, against a spy database) ────────────── */

type Where = { tenantId?: string; key?: { in: string[] } };
const calls: { settingsWhere: Where[]; brandFor: (string | null)[] } = { settingsWhere: [], brandFor: [] };
const REQUESTS: Record<string, { tenantId: string | null; quoteId: string | null; createdById: string | null; expiresAt: Date | null }> = {
  req_a: { tenantId: "t_a", quoteId: "q1", createdById: "u1", expiresAt: null },
  req_b: { tenantId: "t_b", quoteId: null, createdById: null, expiresAt: null },
};
const STORE = [
  { tenantId: "t_a", key: "SIGNING_EMAIL_INVITE", value: JSON.stringify({ subject: "A: {{quote_number}} from {{sender_name}}", body: "Tenant A copy\n\n{{signing_link}}" }) },
  { tenantId: "t_a", key: "COMPANY_PHONE", value: "011 000 0000" },
];
const basePrisma = {
  signatureRequest: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id === "req_boom") throw new Error("db down");
      return REQUESTS[where.id] ?? null;
    },
  },
  appSetting: {
    findMany: async ({ where }: { where: Where }) => {
      calls.settingsWhere.push(where);
      return STORE.filter((r) => r.tenantId === where.tenantId && where.key!.in.includes(r.key));
    },
  },
  quote: { findFirst: async ({ where }: { where: { id: string; tenantId: string } }) => (where.tenantId === "t_a" ? { number: 1026 } : null) },
  user: { findUnique: async () => ({ name: "Sam Sales" }) },
};
const loaderKey = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/db") return { basePrisma, prisma: basePrisma };
  if (request === "@/lib/settings") return { decryptValue: (s: string) => s };
  if (request === "@/lib/emailBrand") {
    return { emailBrand: async (t: string | null) => ({ logoUrl: t ? `https://x.test/api/brand/logo/${t}` : null }) };
  }
  if (request === "@/lib/tenantBrand") {
    return {
      DEFAULT_BRAND: { tenantId: null, displayName: "CRM", tagline: null, primary: null, primaryForeground: null, logoRef: null },
      brandForTenant: async (t: string | null) => {
        calls.brandFor.push(t);
        return { tenantId: t, displayName: t === "t_a" ? "Acme" : "Bravo", tagline: null, primary: t === "t_a" ? "#00ff00" : null, primaryForeground: t === "t_a" ? "#0f172a" : null, logoRef: null };
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};
const { signingEmailContent } = createRequire(import.meta.url)(
  "../src/lib/signing/signingEmail.ts",
) as typeof import("../src/lib/signing/signingEmail");

test("each request renders from ITS tenant's template and brand only", async () => {
  const a = await signingEmailContent("invite", { requestId: "req_a", title: "Quote Q-1026", recipientName: "Jane", signingUrl: URL_ });
  assert.equal(a.subject, "A: Q-1026 from Sam Sales");
  assert.match(a.text, /^Tenant A copy/);
  assert.match(a.html, /fillcolor="#00ff00"/);
  assert.match(a.html, /011 000 0000/);
  assert.match(a.html, /api\/brand\/logo\/t_a/);

  const b = await signingEmailContent("invite", { requestId: "req_b", title: "Contract", recipientName: "Bob", signingUrl: URL_ });
  assert.equal(b.subject, "Please sign your document: Contract", "tenant B has no override → default, never tenant A's");
  assert.doesNotMatch(b.html, /Tenant A|011 000 0000|#00ff00|t_a/);
  assert.match(b.html, /api\/brand\/logo\/t_b/);
  assert.match(b.html, /Thank you,<br>Bravo/);

  assert.deepEqual(calls.settingsWhere.map((w) => w.tenantId), ["t_a", "t_b"], "settings read by the request's own tenant");
  assert.deepEqual(calls.brandFor, ["t_a", "t_b"]);
});

test("a failed lookup still sends the default email with the link", async () => {
  const e = await signingEmailContent("invite", { requestId: "req_boom", title: "Quote Q-9", recipientName: "Jane", signingUrl: URL_ });
  assert.equal(e.subject, "Please sign your document: Quote Q-9");
  assert.ok(e.html.includes(`href="${URL_}"`));
});
