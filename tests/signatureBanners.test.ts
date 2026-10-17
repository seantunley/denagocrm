import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  BANNER_MAX_RECIPIENTS,
  BANNER_MAX_WIDTH,
  CLICK_DEDUPE_MINUTES,
  CLICK_MAX_ANONYMOUS_PER_DAY,
  CLICK_MAX_PER_EMAIL,
  CLICK_RETENTION_DAYS,
  EMAIL_REF_MARKER,
  anonymousClickDay,
  clickDedupeCutoff,
  clickRetentionCutoff,
  emailClickAllowed,
  NO_BANNER,
  bannerClickDestination,
  bannerClickUrl,
  bannerRecipients,
  chooseBanner,
  eligibleBanners,
  nextBannerLink,
  withBannerRef,
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
  assert.match(route, /bannerClickDestination\(\s*\{\s*resolve: resolveBannerLink,/);
  assert.match(route, /NextResponse\.redirect\(destination \?\? appBaseUrl\(\)/);
  const store = src("src/lib/signatureBannerStore.ts");
  // The destination comes off the LINK row, frozen when the email was sent.
  assert.match(store, /prisma\.signatureBannerLink\.findUnique\(\{\s*where: \{ token \},/);
  assert.match(store, /if \(!link \|\| !isBannerLink\(link\.linkUrl\)\) return null;/);
  // The email a click belongs to is looked up inside the banner's own workspace, by its own reference.
  assert.match(store, /where: \{ bannerRef: emailRef, tenantId \}/);
  assert.doesNotMatch(store, /openToken/, "attribution does not lean on open tracking");
  assert.doesNotMatch(store, /ipAddress|userAgent|headers\(/, "a click row keeps no IP address or browser");
});

test("a customer who opted out of marketing gets no banner — checked where every sender goes through", () => {
  const store = src("src/lib/signatureBannerStore.ts");
  assert.match(store, /where: \{ tenantId, marketingOptOut: true, id: \{ in: contactIds \} \}/);
  assert.match(store, /ciExactIds\("contactEmail", address\)/, "by the address typed, not only the record it is filed on");
  const composer = src("src/app/actions/emails.ts");
  assert.match(composer, /bannerForEmail\(\{ tenantId, senderId: user\.id, \.\.\.recipient \}\)/);
  // messageHtml: the message plus its secure-link block when files go as links — the banner rules are unchanged by it.
  assert.match(composer, /composerHtml\(user, messageHtml, profile, \{ to, contactId, leadId, choice \}\)/);
  // Every address, or no banner: never the first few.
  assert.match(store, /const addresses = bannerRecipients\(input\.to\);\s*if \(addresses === null\) return null;/);
  assert.match(store, /addresses\.map\(\(address\) => ciExactIds\("contactEmail", address\)\)/);
  assert.doesNotMatch(store, /\.slice\(/, "no recipient is left unchecked");
});

test("review #851/4: every recipient is checked for an opt-out, or the email carries no banner", () => {
  const many = Array.from({ length: 25 }, (_, i) => `person${i}@example.co.za`);
  assert.equal(bannerRecipients(many.join(", ")), null, "25 recipients: too many to check, so no banner");
  assert.equal(bannerRecipients(many.slice(0, BANNER_MAX_RECIPIENTS).join("; "))?.length, BANNER_MAX_RECIPIENTS, "the limit itself is checked in full");
  // The 21st is exactly the one the old code skipped.
  assert.equal(bannerRecipients(many.slice(0, 21).join(",")), null);
  assert.deepEqual(bannerRecipients(" A@Example.co.za , a@example.co.za ;b@example.co.za"), ["a@example.co.za", "b@example.co.za"]);
  assert.deepEqual(bannerRecipients(""), []);
});

test("review #851/1: changing a banner's address never changes links already sent", () => {
  let made = 0;
  const newToken = () => `new-token-${++made}`;
  const current = { linkUrl: "https://example.co.za/october", token: "october-token" };
  // A new address: a NEW token for emails sent from now on; the old token (and its link row) is untouched.
  assert.deepEqual(nextBannerLink({ current, linkUrl: "https://example.co.za/november", hasLinkRow: true, newToken }), { token: "new-token-1", createLink: true });
  // The same address: same token, nothing new.
  assert.deepEqual(nextBannerLink({ current, linkUrl: current.linkUrl, hasLinkRow: true, newToken }), { token: "october-token", createLink: false });
  // A token with no link row (a save that failed half-way) gets its row, under the same token.
  assert.deepEqual(nextBannerLink({ current, linkUrl: current.linkUrl, hasLinkRow: false, newToken }), { token: "october-token", createLink: true });
  assert.equal(made, 1, "a token is only made when the address changes");

  const actions = src("src/app/actions/signatureBanners.ts");
  // The link row is written BEFORE the banner points at it, and link rows are only ever created.
  assert.ok(actions.indexOf("if (createLink) await prisma.signatureBannerLink.create(") < actions.indexOf("data: { ...data, token, ...(image ?? {}) }"));
  assert.doesNotMatch(actions + src("src/lib/signatureBannerStore.ts"), /signatureBannerLink\.(update|updateMany|upsert|delete|deleteMany)\(/, "a link's address is never edited or removed");
  // And the public resolver reads the link table, so an old token still finds its workspace.
  assert.match(src("src/lib/tokenTenant.ts"), /basePrisma\.signatureBannerLink\.findUnique\(\{\s*where: \{ token \},/);
});

test("review #851/2: a click is tied to its email whether or not open tracking is on", () => {
  const sent = withBannerRef(`<a href="https://crm.example/api/track/b/tok?e=${EMAIL_REF_MARKER}">x</a><a href="y?e=${EMAIL_REF_MARKER}">again</a>`, () => "ref-for-this-email");
  assert.equal(sent.ref, "ref-for-this-email");
  assert.equal(sent.html.split("ref-for-this-email").length - 1, 2, "every banner link in the email names the same email");
  assert.doesNotMatch(sent.html, /__crm_email_ref__/);
  let called = 0;
  assert.deepEqual(withBannerRef("<p>no banner here</p>", () => { called++; return "unused"; }), { html: "<p>no banner here</p>", ref: null });
  assert.equal(called, 0, "an email with no banner gets no reference");

  // In the mail sender it sits OUTSIDE the open-tracking branch, and is stored under its own column.
  const email = src("src/lib/email.ts");
  const tracking = email.slice(email.indexOf("if (html && input.trackOpens) {"), email.indexOf("let bannerRef: string | undefined;"));
  assert.ok(tracking.length > 0 && !tracking.includes("withBannerRef"), "not inside the tracking branch");
  assert.match(email, /const referenced = withBannerRef\(html, newOpenToken\);/);
  assert.match(email, /if \(referenced\.ref\) logged\.bannerRef = bannerRef = referenced\.ref;/);
  assert.match(src("src/lib/outboundMessageLog.ts"), /\.\.\.\(msg\.bannerRef \? \{ bannerRef: msg\.bannerRef \} : \{\}\),/);
  assert.match(src("src/app/actions/emails.ts"), /\.\.\.\(result\.bannerRef \? \{ bannerRef: result\.bannerRef \} : \{\}\),/);
  assert.match(src("prisma/schema.prisma"), /bannerRef\s+String\?\s+@unique/);
});

test("review #851/3: the customer reaches the page even when counting the click fails", async () => {
  const link = { destination: "https://example.co.za/november" };
  const errors: unknown[] = [];
  // `defer` as the platform provides it: the work is kept and run after the response.
  const later: (() => Promise<void>)[] = [];
  const defer = (work: () => Promise<void>) => { later.push(work); };
  const failing = { resolve: async () => link, record: async () => { throw new Error("database is down"); }, onRecordError: (e: unknown) => { errors.push(e); }, defer };
  assert.equal(await bannerClickDestination(failing, "tok", "ref"), link.destination, "sent on regardless");
  await later.shift()!();
  assert.equal(errors.length, 1, "and the failure is reported, not swallowed");
  // Even the reporting failing does not escape into the platform's hook.
  assert.equal(await bannerClickDestination({ ...failing, onRecordError: () => { throw new Error("log is down too"); } }, "tok", null), link.destination);
  await assert.doesNotReject(later.shift()!());
  // An unknown link is the only thing that lands on home — and nothing is recorded or scheduled for it.
  let recorded = 0;
  assert.equal(await bannerClickDestination({ resolve: async () => null, record: async () => { recorded++; }, onRecordError: () => {}, defer }, "nope", null), null);
  assert.equal(later.length, 0);
  assert.equal(recorded, 0);
  // The hook itself failing still sends them on, and is reported.
  const hookErrors: unknown[] = [];
  assert.equal(await bannerClickDestination({ resolve: async () => link, record: async () => {}, onRecordError: (e) => { hookErrors.push(e); }, defer: () => { throw new Error("no after() here"); } }, "tok", null), link.destination);
  assert.equal(hookErrors.length, 1);
});

test("review #851/5: the customer is not kept waiting for the count or the notification", async () => {
  const link = { destination: "https://example.co.za/november" };
  let started = 0;
  let finished = 0;
  const later: (() => Promise<void>)[] = [];
  // A recording that takes "forever": a stalled database write, or a push service that never answers.
  let release: () => void = () => {};
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const deps = {
    resolve: async () => link,
    record: async () => { started++; await stalled; finished++; },
    onRecordError: () => {},
    defer: (work: () => Promise<void>) => { later.push(work); },
  };
  // The destination comes back while nothing has been recorded — or even started.
  assert.equal(await bannerClickDestination(deps, "tok", "ref"), link.destination);
  assert.equal(started, 0, "recording has not begun when the customer is redirected");
  assert.equal(later.length, 1, "it is handed to the run-after-the-response hook exactly once");
  const running = later[0]();
  await Promise.resolve();
  assert.equal(started, 1);
  assert.equal(finished, 0, "still stalled — and the customer left long ago");
  release();
  await running;
  assert.equal(finished, 1);

  const route = src("src/app/api/track/b/[token]/route.ts");
  assert.match(route, /import \{ after, NextRequest, NextResponse \} from "next\/server";/);
  assert.match(route, /defer: \(work\) => after\(work\),/);
  assert.doesNotMatch(route, /await recordBannerClick/, "the route never awaits the recording");
  // Deferred work runs after the request's scope is gone, so it opens its own on the link's workspace.
  assert.match(route, /async \(\) => \(\{ tenantId: link\.tenantId \}\),\s*\(\) => recordBannerClick\(link, emailRef\),/);
});

test("review #851/5: what a replayed or scanned link may write is bounded", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  assert.equal(clickDedupeCutoff(now).toISOString(), "2026-11-10T11:50:00.000Z", `one counted click per email per ${CLICK_DEDUPE_MINUTES} minutes`);
  assert.equal(emailClickAllowed(0), true);
  assert.equal(emailClickAllowed(CLICK_MAX_PER_EMAIL - 1), true);
  assert.equal(emailClickAllowed(CLICK_MAX_PER_EMAIL), false, "and no more than the cap in all");
  assert.equal(anonymousClickDay(now), "2026-11-10");
  assert.equal(clickRetentionCutoff(now).toISOString(), new Date(now.getTime() - CLICK_RETENTION_DAYS * 86_400_000).toISOString());
  assert.ok(CLICK_MAX_ANONYMOUS_PER_DAY > 0 && CLICK_MAX_ANONYMOUS_PER_DAY <= 1000);

  const store = src("src/lib/signatureBannerStore.ts");
  const record = store.slice(store.indexOf("export async function recordBannerClick"));
  // The time gate is ONE conditional statement, so two fetches arriving together cannot both pass.
  assert.match(record, /where: \{ id: email\.id, tenantId, OR: \[\{ bannerLastClickAt: null \}, \{ bannerLastClickAt: \{ lt: clickDedupeCutoff\(now\) \} \}\] \},\s*data: \{ bannerLastClickAt: now \},/);
  assert.match(record, /if \(gate\.count !== 1\) return;/);
  assert.match(record, /if \(!emailClickAllowed\(counted\)\) return;/);
  // Clicks tied to no email take a place under a daily cap, also one statement each.
  assert.match(record, /anonymousDay: day, anonymousClicks: \{ lt: CLICK_MAX_ANONYMOUS_PER_DAY \} \},\s*data: \{ anonymousClicks: \{ increment: 1 \} \},/);
  assert.match(record, /if \(underCap\.count !== 1\) return;/);
  // Nothing is counted, and no row written, before the gates.
  const gates = record.indexOf("if (underCap.count !== 1) return;");
  assert.ok(gates > 0 && record.indexOf("clickCount: { increment: 1 }") > gates && record.indexOf("signatureBannerClick.create(") > gates);
  assert.ok(record.indexOf("signatureBannerClick.create(") < record.indexOf("sendPushToAll("), "an uncounted click notifies nobody");
  // And old rows are removed as new ones arrive.
  assert.match(record, /signatureBannerClick\.deleteMany\(\{ where: \{ tenantId, bannerId, clickedAt: \{ lt: clickRetentionCutoff\(now\) \} \} \}\)/);
  // Deliberately not an IP limit: scanners and mail proxies share addresses.
  assert.doesNotMatch(src("src/app/api/track/b/[token]/route.ts") + store, /throttlePublic|checkPublicThrottle/);
});

test("the sender may pick among their own live banners, or none — never anything else", () => {
  const promo = banner({ id: "promo", endsAt: day("2026-11-30") });
  const standing = banner({ id: "standing" });
  const off = banner({ id: "off", active: false });
  const theirs = banner({ id: "someone-elses", senderIds: ["u9"] });
  const mine = eligibleBanners([standing, off, theirs, promo], { id: "u1" }, NOW);
  assert.deepEqual(mine.map((b) => b.id), ["promo", "standing"], "the default first; off and other people's are not offered");
  assert.equal(chooseBanner(mine, "")?.id, "promo");
  assert.equal(chooseBanner(mine, "standing")?.id, "standing");
  assert.equal(chooseBanner(mine, NO_BANNER), null);
  for (const forged of ["off", "someone-elses", "made-up"]) assert.equal(chooseBanner(mine, forged)?.id, "promo", `${forged} falls back to the default`);
  assert.equal(chooseBanner([], "standing"), null);
  const composer = src("src/components/EmailComposer.tsx");
  // On the ribbon's Options now: the usual one first, the sender's others, or none.
  // A picker in the ribbon's row, posted through one hidden field (#893).
  assert.match(composer, /<input type="hidden" name="banner" value=\{banner\} \/>/);
  assert.match(composer, /<select [^>]*value=\{banner\} onChange=\{\(event\) => update\(\{ banner: event\.target\.value \}\)\}><option value="">\{banners\[0\]\.name\} \(default\)<\/option>/);
  assert.match(composer, /<option value="none">No banner<\/option>/);
  assert.match(src("src/app/actions/emails.ts"), /const choice = String\(formData\.get\("banner"\) \?\? ""\)\.slice\(0, 64\);/);
});

test("a preview's banner is not a tracked link, and a sent email's is", () => {
  const composer = src("src/app/actions/emails.ts");
  assert.match(composer, /bannerHtml\(banner, preview \? banner\.linkUrl : bannerClickUrl\(origin, banner\.token\)\)/);
  // (Wrapped as bookkeeping: once the email has left, a failed count must not report the send as failed.)
  assert.match(composer, /if \(bannerId && bannerTenantId\) await bookkeeping\("count the banner", \(\) => recordBannerSent\(bannerTenantId, bannerId\)\);/);
  // …and only after the email has actually left: a failed send counts nothing.
  assert.ok(composer.indexOf("return { error: result.error };") < composer.indexOf("recordBannerSent(bannerTenantId, bannerId)"));
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
  assert.match(actions, /data: \{ tenantId, \.\.\.data, \.\.\.image, active: false, token \}/);
  assert.equal((actions.match(/await workspace\(\)/g) ?? []).length, 3, "all three actions");
  assert.match(actions, /const user = await requireTenantOwner\(\);/);
  // Every write names the workspace: the owner check says who is asking, not whose row it is.
  assert.match(actions, /updateMany\(\{ where: \{ id, tenantId \}/);
  assert.match(actions, /updateMany\(\{ where: \{ id: banner\.id, tenantId \}/);
  assert.match(src("src/app/(app)/settings/signature-banners/page.tsx"), /await requireTenantOwner\(\);/);
});

test("the tables are isolated per workspace, additively", () => {
  const sql = src("prisma/migrations/20261011140000_signature_banners/migration.sql");
  for (const table of ["SignatureBanner", "SignatureBannerLink", "SignatureBannerClick"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`CREATE POLICY "${table}_tenant_isolation" ON "${table}"`));
  }
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|DELETE FROM|UPDATE "/i, "additive only");
});
