import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  BANNER_MAX_WIDTH,
  EMAIL_REF_MARKER,
  bannerClickUrl,
  bannerDay,
  bannerDayValue,
  bannerDisplaySize,
  bannerHtml,
  bannerPosition,
  bannerState,
  placeBannerInEmail,
  clickRate,
  isBannerLink,
  pickBanner,
  type BannerRow,
} from "../src/lib/signatureBanners";
import { seenLabel } from "../src/lib/emailOpenTracking";

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const day = (value: string) => new Date(`${value}T10:00:00+02:00`);
const NOW = day("2026-11-10");

function banner(over: Partial<BannerRow> & { id: string }): BannerRow {
  return {
    name: over.id, imageUrl: "https://files.example/b.png", width: 600, height: 150, linkUrl: "https://example.co.za/special", altText: "",
    active: true, startsAt: null, endsAt: null, senderIds: [], teamIds: [], position: "below", onQuoteEmails: false, token: "t".repeat(32), createdAt: day("2026-10-01"), ...over,
  };
}

test("a banner is off until switched on, waits for its first day, and is over after its last", () => {
  assert.equal(bannerState(banner({ id: "a", active: false }), NOW), "off");
  assert.equal(bannerState(banner({ id: "a" }), NOW), "live");
  assert.equal(bannerState(banner({ id: "a", startsAt: day("2026-11-11") }), NOW), "scheduled");
  assert.equal(bannerState(banner({ id: "a", endsAt: day("2026-11-09") }), NOW), "ended");
  // Ended even when nobody switched it off — the dates are what end it.
  assert.equal(bannerState(banner({ id: "a", active: false, endsAt: day("2026-11-09") }), NOW), "ended");
});

test("a promotion takes over from the standing banner, and hands back when it ends", () => {
  const standing = banner({ id: "standing" });
  const promo = banner({ id: "promo", startsAt: day("2026-11-01"), endsAt: bannerDay("2026-11-30", "end") });
  assert.equal(pickBanner([standing, promo], { id: "u1" },NOW)?.id, "promo");
  assert.equal(pickBanner([promo, standing], { id: "u1" },NOW)?.id, "promo", "whatever order they are stored in");
  assert.equal(pickBanner([standing, promo], { id: "u1" },day("2026-10-20"))?.id, "standing", "before the promotion starts");
  assert.equal(pickBanner([standing, promo], { id: "u1" },day("2026-12-01"))?.id, "standing", "after its last day, by itself");
  // The last day counts, to the end of it.
  assert.equal(pickBanner([standing, promo], { id: "u1" },new Date("2026-11-30T21:00:00+02:00"))?.id, "promo");
});

test("nothing switched on means no banner at all", () => {
  assert.equal(pickBanner([banner({ id: "a", active: false })], { id: "u1" },NOW), null);
  assert.equal(pickBanner([], { id: "u1" },NOW), null);
});

test("a banner for named people is on their emails only", () => {
  const sales = banner({ id: "sales", senderIds: ["u1"] });
  const all = banner({ id: "all", createdAt: day("2026-09-01") });
  assert.equal(pickBanner([sales], { id: "u2" },NOW), null);
  assert.equal(pickBanner([sales, all], { id: "u2" },NOW)?.id, "all");
  assert.equal(pickBanner([sales, all], { id: "u1" },NOW)?.id, "sales", "the newer of two standing banners");
});

test("a banner for a team is on the emails of whoever is in it, and named people as well", () => {
  const sales = banner({ id: "sales-team", teamIds: ["t-sales"], senderIds: ["u9"] });
  assert.equal(pickBanner([sales], { id: "u1", teamIds: ["t-sales"] }, NOW)?.id, "sales-team");
  assert.equal(pickBanner([sales], { id: "u1", teamIds: ["t-workshop"] }, NOW), null);
  assert.equal(pickBanner([sales], { id: "u1" }, NOW), null, "no teams known is no team");
  assert.equal(pickBanner([sales], { id: "u9" }, NOW)?.id, "sales-team", "named outside the team");
});

test("a quote email only carries a banner the owner ticked for quotes", () => {
  const everywhere = banner({ id: "both", onQuoteEmails: true, createdAt: day("2026-09-01") });
  const lettersOnly = banner({ id: "letters" });
  assert.equal(pickBanner([lettersOnly], { id: "u1" }, NOW, "quote"), null);
  assert.equal(pickBanner([lettersOnly, everywhere], { id: "u1" }, NOW, "quote")?.id, "both");
  assert.equal(pickBanner([lettersOnly, everywhere], { id: "u1" }, NOW)?.id, "letters", "the composer takes either; the newer wins");
});

test("a banner goes into a finished email above the message or below everything", () => {
  const email = '<html><body style="margin:0"><p>Your quote</p><img src="pixel" /></body></html>';
  const above = placeBannerInEmail(email, "<b>AD</b>", "above");
  const below = placeBannerInEmail(email, "<b>AD</b>", "below");
  assert.ok(above.indexOf("<b>AD</b>") > above.indexOf('<body style="margin:0">') && above.indexOf("<b>AD</b>") < above.indexOf("Your quote"));
  assert.ok(below.indexOf("<b>AD</b>") > below.indexOf("pixel") && below.indexOf("<b>AD</b>") < below.indexOf("</body>"));
  assert.match(placeBannerInEmail("<p>no body tag</p>", "<b>AD</b>", "below"), /<p>no body tag<\/p><div/);
  assert.equal(bannerPosition("above"), "above");
  assert.equal(bannerPosition("sideways"), "below", "anything else is under the signature");
});

test("a click shows on the email's timeline entry, with or without an open", () => {
  const at = new Date("2026-11-10T12:00:00+02:00");
  assert.match(seenLabel({ type: "email", direction: "outbound", seenAt: null, bannerClickedAt: at }) ?? "", /^👆 Clicked your banner /);
  assert.match(seenLabel({ type: "email", direction: "outbound", seenAt: at, openCount: 2, bannerClickedAt: at }) ?? "", /^👁 Opened .+ · 2× · 👆 Clicked your banner /);
  assert.equal(seenLabel({ type: "email", direction: "inbound", bannerClickedAt: at }), null);
});

test("of two promotions running at once, the one that started later shows", () => {
  const first = banner({ id: "first", startsAt: day("2026-11-01"), endsAt: day("2026-11-30") });
  const second = banner({ id: "second", startsAt: day("2026-11-08"), endsAt: day("2026-11-15") });
  assert.equal(pickBanner([first, second], { id: "u1" },NOW)?.id, "second");
});

test("the banner's HTML is email-safe and escapes what the owner typed", () => {
  const html = bannerHtml(banner({ id: "a", name: 'Spring "sale"', altText: "" }), bannerClickUrl("https://crm.example.co.za/", "tok"));
  assert.match(html, /<table cellpadding="0" cellspacing="0" border="0" role="presentation"/);
  assert.match(html, /href="https:\/\/crm\.example\.co\.za\/api\/track\/b\/tok\?e=__crm_email_ref__"/);
  assert.match(html, /width="600" height="150" style="display:block;border:0;width:600px;max-width:100%;height:auto;"/);
  // With no alt text of its own, the name is what a reader sees while images are blocked.
  assert.match(html, /alt="Spring &quot;sale&quot;"/);
  assert.doesNotMatch(html, /<script|style=[^"]/);
});

test("a click can only be sent to a plain https address", () => {
  assert.ok(isBannerLink("https://www.example.co.za/special?utm_source=signature"));
  for (const bad of ["http://example.co.za", "javascript:alert(1)", "https://user:pw@example.co.za", "https://localhost", "//example.co.za", 'https://example.co.za/"onmouseover=', "https://example.co.za/a b", ""]) {
    assert.equal(isBannerLink(bad), false, bad);
  }
});

test("an uploaded image is shown no wider than the cap, never enlarged, and not if it is tall", () => {
  assert.deepEqual(bannerDisplaySize(1200, 300), { width: BANNER_MAX_WIDTH, height: 150 });
  assert.deepEqual(bannerDisplaySize(400, 100), { width: 400, height: 100 });
  assert.equal(bannerDisplaySize(600, 900), null, "a poster, not a banner");
  assert.equal(bannerDisplaySize(80, 20), null, "too small to read");
  assert.equal(bannerDisplaySize(Number.NaN, 100), null);
});

test("form dates are whole South African days, and round-trip", () => {
  assert.equal(bannerDay("2026-11-01", "start")?.toISOString(), "2026-10-31T22:00:00.000Z");
  assert.equal(bannerDay("2026-11-30", "end")?.toISOString(), "2026-11-30T21:59:59.999Z");
  assert.equal(bannerDayValue(bannerDay("2026-11-01", "start")), "2026-11-01");
  assert.equal(bannerDayValue(bannerDay("2026-11-30", "end")), "2026-11-30");
  assert.equal(bannerDay("30/11/2026", "end"), null);
  assert.equal(bannerDayValue(null), "");
});

test("click rate reads sensibly at the edges", () => {
  assert.equal(clickRate(0, 0), "—");
  assert.equal(clickRate(200, 8), "4%");
  assert.equal(clickRate(1000, 3), "0.3%");
});

/* ── The wiring: rules that only hold if the callers use them ─────────────── */

test("the click route never reads its destination from the request", () => {
  const route = src("src/app/api/track/b/[token]/route.ts");
  assert.doesNotMatch(route, /searchParams\.get\("u"\)|searchParams\.get\("url"\)|searchParams\.get\("to"\)/);
  assert.match(route, /recordBannerClick\(token, req\.nextUrl\.searchParams\.get\("e"\)\)/);
  assert.match(route, /NextResponse\.redirect\(destination \?\? appBaseUrl\(\)/);
  const store = src("src/lib/signatureBannerStore.ts");
  assert.match(store, /if \(!banner \|\| !isBannerLink\(banner\.linkUrl\)\) return null;/);
  // The email a click belongs to is looked up inside the banner's own workspace.
  assert.match(store, /where: \{ openToken: emailRef, tenantId \}/);
  assert.doesNotMatch(store, /ipAddress|userAgent|headers\(/, "a click row keeps no IP address or browser");
});

test("a customer who opted out of marketing gets no banner — checked where every sender goes through", () => {
  const store = src("src/lib/signatureBannerStore.ts");
  assert.match(store, /where: \{ tenantId, marketingOptOut: true, id: \{ in: contactIds \} \}/);
  assert.match(store, /ciExactIds\("contactEmail", address\)/, "by the address typed, not only the record it is filed on");
  const composer = src("src/app/actions/emails.ts");
  assert.match(composer, /bannerForEmail\(\{ tenantId, senderId: user\.id, \.\.\.recipient \}\)/);
  assert.match(composer, /composerHtml\(user, bodyHtml, profile, \{ to, contactId, leadId \}\)/);
});

test("a preview's banner is not a tracked link, and a sent email's is", () => {
  const composer = src("src/app/actions/emails.ts");
  assert.match(composer, /bannerHtml\(banner, preview \? banner\.linkUrl : bannerClickUrl\(origin, banner\.token\)\)/);
  assert.match(composer, /if \(bannerId && sendingTenantId\) await recordBannerSent\(sendingTenantId, bannerId\);/);
  // The mail sender fills in which email the banner is in, or nothing.
  assert.match(src("src/lib/email.ts"), /html\.replaceAll\(EMAIL_REF_MARKER, openToken \?\? ""\)/);
  assert.equal(EMAIL_REF_MARKER, "__crm_email_ref__");
});

test("a quote a person emails carries a ticked banner, counted and opt-out checked like any other", () => {
  const action = src("src/app/actions/quoteEmail.ts");
  assert.match(action, /place: "quote",\s*to: to\.value,\s*contactId: quote\.contactId,\s*leadId: quote\.leadId,/);
  assert.match(action, /html: marketed\.html,/);
  assert.match(action, /if \(marketed\.bannerId && quote\.tenantId\) await recordBannerSent\(quote\.tenantId, marketed\.bannerId\);/);
  // The one door: emailWithBanner goes through bannerForEmail, where the opt-out is.
  assert.match(src("src/lib/signatureBannerStore.ts"), /const banner = await bannerForEmail\(\{ \.\.\.input, tenantId \}\)\.catch\(\(\) => null\);/);
  // Signing invitations and automatic messages are not wired to it at all.
  for (const file of ["src/lib/signing/signingEmail.ts", "src/lib/signing/dispatch.ts"]) assert.doesNotMatch(src(file), /signatureBanner|emailWithBanner/, file);
});

test("the first click is decided by the database, so the sender is told once", () => {
  const store = src("src/lib/signatureBannerStore.ts");
  assert.match(store, /updateMany\(\{ where: \{ id: email\.id, tenantId, bannerClickedAt: null \}, data: \{ bannerClickedAt: new Date\(\) \} \}\)\)\.count === 1/);
  assert.match(store, /if \(email\?\.userId && first\) \{/);
});

test("a new banner is saved switched off, and only the workspace owner can change one", () => {
  const actions = src("src/app/actions/signatureBanners.ts");
  assert.match(actions, /data: \{ tenantId, \.\.\.data, \.\.\.image, active: false, token:/);
  assert.equal((actions.match(/await workspace\(\)/g) ?? []).length, 2, "both actions");
  assert.match(actions, /const user = await requireTenantOwner\(\);/);
  // Every write names the workspace: the owner check says who is asking, not whose row it is.
  assert.match(actions, /updateMany\(\{ where: \{ id, tenantId \}/);
  assert.match(actions, /updateMany\(\{ where: \{ id: banner\.id, tenantId \}/);
  assert.match(src("src/app/(app)/settings/signature-banners/page.tsx"), /await requireTenantOwner\(\);/);
});

test("the tables are isolated per workspace, additively", () => {
  const sql = src("prisma/migrations/20261011140000_signature_banners/migration.sql");
  for (const table of ["SignatureBanner", "SignatureBannerClick"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"`));
  }
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|UPDATE "/i, "additive only");
});
