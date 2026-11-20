import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSignatureDesign } from "../src/lib/signature";
import { rewriteSignatureLinks, signatureLinkKind, signatureLinkUrls, SIGNATURE_LINK_REF } from "../src/lib/signatureLinks";

// The Email signatures pack, items 7 and 11 (Sean, 2026-11-20): see the signature on a phone and in dark mode and send
// yourself a test; count clicks on the signature's links.

const src = (f: string) => readFileSync(f, "utf8");

test("which links: web links only, each once, escaped addresses read back; pictures and tel:/mailto: left alone", () => {
  const html = `<a href="https://acme.example/?a=1&amp;b=2">site</a><img src="https://acme.example/logo.png" />
    <a href="tel:0215551234">call</a><a href="mailto:a@b.c">mail</a><a href="https://wa.me/27821112222">wa</a><a href="https://acme.example/?a=1&amp;b=2">again</a>`;
  assert.deepEqual(signatureLinkUrls(html), ["https://acme.example/?a=1&b=2", "https://wa.me/27821112222"]);
  const out = rewriteSignatureLinks(html, (url) => (url.includes("wa.me") ? "https://crm.example/api/track/s/tok" : undefined));
  assert.match(out, /href="https:\/\/crm\.example\/api\/track\/s\/tok">wa/);
  assert.match(out, /href="https:\/\/acme\.example\/\?a=1&amp;b=2">site/, "a link with no token stays as it was");
  assert.match(out, /href="tel:0215551234"/);
  assert.match(out, /<img src="https:\/\/acme\.example\/logo\.png"/);
});

test("what kind of link: by its own address, then by the signature's settings", () => {
  const known = { website: "acme.example", bookingUrl: "https://cal.example/ann", privacyUrl: "https://acme.example/privacy" };
  assert.equal(signatureLinkKind("https://wa.me/2782", known), "whatsapp");
  assert.equal(signatureLinkKind("https://www.facebook.com/acme", known), "facebook");
  assert.equal(signatureLinkKind("https://instagram.com/acme", known), "instagram");
  assert.equal(signatureLinkKind("https://cal.example/ann/", known), "booking");
  assert.equal(signatureLinkKind("https://acme.example/privacy", known), "privacy");
  assert.equal(signatureLinkKind("https://www.acme.example/", known), "website");
  assert.equal(signatureLinkKind("https://elsewhere.example/", known), "link");
});

test("counting is the owner's switch, off by default, and part of the pack; real sends only", () => {
  assert.equal(parseSignatureDesign(null).trackLinks, false);
  assert.equal(parseSignatureDesign(JSON.stringify({ trackLinks: true })).trackLinks, true);
  const store = src("src/lib/signatureLinkStore.ts");
  assert.match(store, /if \(!tenantId \|\| !args\.on\) return signatureHtml;/);
  assert.match(store, /if \(!\(await isModuleEnabled\("signatures"\)\)\) return signatureHtml;/);
  assert.match(store, /\} catch \{\s*return signatureHtml;\s*\}/, "a failure never loses the email; the links go as written");
  const composer = src("src/lib/composerSend.ts");
  assert.match(composer, /const counted = preview\s*\? signature\s*: await trackSignatureLinks\(/, "never on a preview");
  assert.match(src("src/app/actions/quoteEmail.ts"), /await trackSignatureLinks\(\s*\{ tenantId, userId: user\.id, origin, on: design\.trackLinks/);
  assert.match(src("src/app/actions/emailSignatures.ts"), /trackLinks: formData\.get\("trackLinks"\) === "on",/);
});

test("the click route: the stored address only (no open redirect), answers first, counts after, bounded", () => {
  const route = src("src/app/api/track/s/[token]/route.ts");
  assert.match(route, /if \(SIGNATURE_LINK_REF\.test\(token\)\)/);
  assert.doesNotMatch(route, /searchParams/, "nothing about the destination is read from the request");
  assert.match(route, /after\(\(\) =>/);
  assert.match(route, /NextResponse\.redirect\(destination \?\? appBaseUrl\(\)/);
  assert.ok(SIGNATURE_LINK_REF.test("a".repeat(24)) && !SIGNATURE_LINK_REF.test("../x"));
  const store = src("src/lib/signatureLinkStore.ts");
  assert.match(store, /return link && \/\^https:/, "only a plain https address is followed");
  assert.match(store, /lastClickAt: \{ lt: new Date\(now\.getTime\(\) - LINK_CLICK_DEDUPE_SECONDS \* 1000\) \}/);
  assert.match(store, /dayClicks: \{ lt: CLICK_MAX_ANONYMOUS_PER_DAY \}/);
  assert.match(src("src/lib/redactUrl.ts"), /"api\/track\/s",/, "the token is kept out of logs");
  assert.match(src("src/lib/tokenTenant.ts"), /export async function resolveSignatureLinkTenant/);
});

test("the table: additive, walled per workspace like the banner tables", () => {
  const sql = src("prisma/migrations/20261120150000_signature_links/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "SignatureLink"/);
  assert.match(sql, /ALTER TABLE "SignatureLink" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "SignatureLink" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /"tenantId" = current_setting\('app\.current_tenant', true\)/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});

test("send myself a test: the real email to their own address, the pack's, never a counted click", () => {
  const actions = src("src/app/actions/emailSignatures.ts");
  const fn = actions.slice(actions.indexOf("export async function sendMySignatureTest"), actions.indexOf("/** The owner's rules"));
  assert.match(fn, /const user = await requireUser\(\);/);
  assert.match(fn, /isModuleEnabled\("signatures"\)/);
  assert.match(fn, /to: user\.email,/);
  assert.match(fn, /\{ to: user\.email \},[\s\S]*?true,\s*\)/, "built as the preview builds it: banner links not counted");
  assert.match(fn, /logAudit\(/);
  const editor = src("src/components/SignatureVisualEditor.tsx");
  assert.match(editor, /\(\["computer", "phone", "dark"\] as const\)/);
  assert.match(editor, /view === "phone" \? "w-\[375px\] max-w-full"/);
  assert.match(editor, /img\{filter:invert\(1\) hue-rotate\(180deg\)\}/, "dark mode flips colours, not pictures");
  assert.match(src("src/components/EmailSignatureDetails.tsx"), /editor\(me, saveMySignatureDetails, "Save my signature", isOwner, sendMySignatureTest\)/);
});
