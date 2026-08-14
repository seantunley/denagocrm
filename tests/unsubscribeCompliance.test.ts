import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The pure half. campaigns.ts reaches `server-only` through emailBrand, so it
// cannot be imported here — which is why these two live in their own module and
// why the assertions below are about output rather than about source text.
import { unsubscribeUrlFor, unsubscribeHeadersFor } from "../src/lib/unsubscribeLinks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/**
 * Comments are not behaviour. Every positional assertion below runs against the
 * stripped source, because a sentence in a doc comment mentioning the thing an
 * assertion forbids will satisfy — or defeat — the assertion while changing
 * nothing about what ships.
 */
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE = "src/app/api/unsubscribe/[token]/route.ts";

/* ── 1. The landing page names the sender, not Denago ──────────────────────── */

test("the unsubscribe page carries no hard-coded tenant name", () => {
  // The email around this page resolves the logo, display name and origin per
  // tenant, and routes THIS link through the tenant's own hostname on the stated
  // grounds that it is the link a distrustful recipient clicks. The page then
  // said "Denago Cape Town" to every tenant's customers.
  const code = shipped(ROUTE);
  assert.doesNotMatch(code, /Denago/i, "the page must name the tenant that sent the mail, not a fixed one");
  assert.match(code, /brandForTenant\(/, "…which means resolving the brand from the token's tenant");
});

test("an unresolvable tenant falls back to the platform name, not to a customer", () => {
  // Same rule emailShell settled on: the failure mode of a branding system has
  // to be anonymity. brandForTenant(null) returns DEFAULT_BRAND, whose
  // displayName is PLATFORM_NAME — so the fallback is inherited rather than
  // re-implemented here, and this pins that it is not replaced by a literal.
  const code = shipped(ROUTE);
  assert.match(code, /brandForTenant\(owner\?\.tenantId \?\? null\)/);
  assert.match(code, /brand\.displayName/);
});

test("the tenant name is escaped everywhere it reaches the page", () => {
  // Operator-controlled, but it renders to that tenant's customers, and it lands
  // in a <title>, an <h1> and a sentence. The shared encoder is safe in both
  // text and attribute positions — the failure it exists to prevent was reaching
  // for none.
  const code = shipped(ROUTE);
  assert.match(code, /escapeHtml\(brandName\)/, "the heading and title");
  assert.match(code, /escapeHtml\(text\)/, "the message body");
  assert.match(code, /escapeHtml\(name\)/, "and the name inside the confirmation question");
});

/* ── 2. The mutation is on POST, and GET is a confirmation ─────────────────── */

test("GET offers a form and POST is what writes", () => {
  const code = shipped(ROUTE);
  const get = code.indexOf("export async function GET");
  const post = code.indexOf("export async function POST");
  assert.ok(get >= 0 && post >= 0, "both handlers must exist");

  const getBody = code.slice(get, post);
  assert.match(getBody, /<form method="post"/, "the confirmation page must submit back to this route");
  assert.doesNotMatch(getBody, /marketingOptOut/, "GET must not perform the opt-out");

  const postBody = code.slice(post);
  assert.match(postBody, /marketingOptOut: true/, "POST performs it");
});

test("the opt-out still commits inside the recipient's tenant scope", () => {
  // Unchanged property, moved handler. withTokenTenantScope is what stops the
  // guarded write running unscoped or against the wrong tenant under
  // enforcement, and moving code between verbs is exactly when a wrapper gets
  // dropped.
  const code = shipped(ROUTE);
  const post = code.slice(code.indexOf("export async function POST"));
  assert.match(post, /withTokenTenantScope\(/);
  assert.match(post, /\(\) => false,/, "an unresolvable tenant must fail closed, not write");

  // The scope resolves from the SAME trusted pre-scope lookup that named the
  // brand, rather than from anything the request supplied — one answer to "whose
  // tenant is this", used for both the name on the page and the write.
  assert.match(post, /\(\) => Promise\.resolve\(owner\)/);
  assert.match(code, /const owner = await resolveCampaignRecipientTenant\(token\);/);
});

test("success is claimed only when the write committed", () => {
  // Pre-existing and load-bearing: telling someone they have been unsubscribed
  // when nothing committed is the compliance failure this route exists to avoid.
  // Preserved across the GET/POST split.
  const post = shipped(ROUTE).slice(shipped(ROUTE).indexOf("export async function POST"));
  assert.match(post, /done\s*\n?\s*\?\s*`You've been unsubscribed from \$\{name\}/);
  assert.match(post, /:\s*INVALID/, "…and anything else keeps the neutral message");
});

/* ── 3. List-Unsubscribe ───────────────────────────────────────────────────── */

test("the header and the footer link address the same endpoint", () => {
  // Two spellings of the same URL is how a mail client's unsubscribe button
  // quietly stops matching the link in the message body.
  const base = "https://acme.example";
  assert.equal(
    unsubscribeHeadersFor(base, "tok123")["List-Unsubscribe"],
    `<${unsubscribeUrlFor(base, "tok123")}>`,
  );
  assert.equal(unsubscribeUrlFor(base, "tok123"), "https://acme.example/api/unsubscribe/tok123");

  // …and the footer link in the message goes through the same function, rather
  // than interpolating the path a second time.
  assert.match(
    shipped("src/lib/campaigns.ts"),
    /emailShell\(rewritten \+ pixel, unsubscribeUrl\(token, brand\), brand\)/,
  );
});

test("List-Unsubscribe-Post is exactly the RFC 8058 token", () => {
  // The value is specified, not descriptive. Anything else and the provider
  // treats the message as offering a link rather than one-click, which is the
  // whole reason for sending it.
  assert.equal(
    unsubscribeHeadersFor("https://x.example", "t")["List-Unsubscribe-Post"],
    "List-Unsubscribe=One-Click",
  );
});

test("the header is angle-bracketed", () => {
  // RFC 2369 requires the URI in angle brackets. A bare URL is silently ignored
  // by some providers — a header that is present and inert is worse than absent,
  // because it looks done.
  const value = unsubscribeHeadersFor("https://x.example", "t")["List-Unsubscribe"];
  assert.equal(value, "<https://x.example/api/unsubscribe/t>");
});

test("the base the header is built from is the one the whole email uses", () => {
  // The pure function takes the base as an argument, so "which base?" is decided
  // by campaigns.ts. That decision must be the SAME emailBase() the tracked
  // links and the logo resolve through — an unresolved tenant yields an empty
  // origin, and a caller falling back on its own would emit
  // "undefined/api/unsubscribe/…" or a root-relative path a mail client cannot
  // resolve at all.
  const code = shipped("src/lib/campaigns.ts");
  const start = code.indexOf("export function unsubscribeHeaders(");
  assert.match(
    code.slice(start, code.indexOf("\n}", start)),
    /unsubscribeHeadersFor\(emailBase\(brand\), token\)/,
  );
  const baseStart = code.indexOf("export function emailBase(");
  assert.match(
    code.slice(baseStart, code.indexOf("\n}", baseStart)),
    /return brand\?\.origin \|\| appBaseUrl\(\);/,
    "empty origin falls back to the platform base, never to undefined",
  );
});

test("both campaign send paths emit the headers", () => {
  // There are two senders — the synchronous first-send batch and the durable
  // queue — and a header added to one of them is a header missing from most of
  // the mail, since the queue drains everything after the first 80.
  for (const [rel, what] of [
    ["src/lib/campaigns.ts", "the synchronous send batch"],
    ["src/lib/marketingCampaignQueue.ts", "the durable outbox"],
  ] as const) {
    assert.match(
      shipped(rel),
      /headers: unsubscribeHeaders\(/,
      `${what} must send List-Unsubscribe`,
    );
  }
});

test("sendEmail actually forwards headers to the transport", () => {
  // A `headers` parameter accepted and dropped would satisfy every call site
  // above while sending nothing — and nothing in this codebase reads the wire.
  const code = shipped("src/lib/email.ts");
  const send = code.slice(code.indexOf("export async function sendEmail"));
  assert.match(send, /headers\?: Record<string, string>/, "the parameter exists");
  assert.match(send, /headers: input\.headers,/, "…and reaches sendMail");
});
