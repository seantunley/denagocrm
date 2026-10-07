import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPEN_TOKEN, newOpenToken, openTrackingOn, seenLabel, withOpenPixel } from "../src/lib/emailOpenTracking";
import { outboundTimelineEntry } from "../src/lib/outboundMessageLog";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("tokens are unguessable and pass the route's format check", () => {
  const a = newOpenToken();
  const b = newOpenToken();
  assert.notEqual(a, b);
  assert.match(a, OPEN_TOKEN);
  assert.ok(!OPEN_TOKEN.test("../../etc"));
  assert.ok(!OPEN_TOKEN.test("short"));
});

test("tracking is on unless the owner switched it off", () => {
  assert.equal(openTrackingOn(null), true);
  assert.equal(openTrackingOn("on"), true);
  assert.equal(openTrackingOn("off"), false);
});

test("the pixel goes last — before </body>, or at the end — on the workspace's address", () => {
  const withBody = withOpenPixel("<html><body><p>Hi</p></body></html>", "https://crm.example.com/", "tok");
  assert.match(withBody, /<p>Hi<\/p><img src="https:\/\/crm\.example\.com\/api\/track\/e\/tok"[^>]*\/><\/body>/);
  const bare = withOpenPixel("<p>Hi</p>", "https://crm.example.com", "tok");
  assert.ok(bare.startsWith("<p>Hi</p><img src=\"https://crm.example.com/api/track/e/tok\""));
});

test("a recorded send keeps its token on the timeline entry; an untracked one has none", () => {
  const base = { channel: "email" as const, to: "a@b.co", text: "Hi" };
  assert.equal(outboundTimelineEntry({ ...base, openToken: "tok" }, { contactId: "c1" }).openToken, "tok");
  assert.ok(!("openToken" in outboundTimelineEntry(base, { contactId: "c1" })));
});

test("sendEmail only tracks when asked AND the workspace hasn't switched it off", () => {
  const email = src("src/lib/email.ts");
  assert.match(email, /if \(html && input\.trackOpens\)/);
  assert.match(email, /openTrackingOn\(await getSetting\(EMAIL_OPEN_TRACKING_KEY\)\)/);
});

test("the composer and quote emails ask for tracking, and the composer stores the token", () => {
  const composer = src("src/app/actions/emails.ts");
  assert.match(composer, /trackOpens: true/);
  assert.match(composer, /result\.openToken \? \{ openToken: result\.openToken \}/);
  assert.match(src("src/app/actions/quoteEmail.ts"), /trackOpens: true/);
});

test("the pixel route answers the same for every token and only stamps a real one", () => {
  const route = src("src/app/api/track/e/[token]/route.ts");
  assert.match(route, /if \(OPEN_TOKEN\.test\(token\)\)/);
  assert.match(route, /seenAt: email\.seenAt \?\? new Date\(\)/);
  assert.match(route, /openCount: \{ increment: 1 \}/);
  assert.match(route, /\.catch\(\(\) => \{\}\)/);
});

test("the badge: only on an outbound message that was opened, with the count past one", () => {
  const at = new Date("2026-10-07T10:00:00Z");
  assert.equal(seenLabel({ type: "email", direction: "outbound", seenAt: null }), null);
  assert.equal(seenLabel({ type: "email", direction: "inbound", seenAt: at }), null);
  assert.match(seenLabel({ type: "email", direction: "outbound", seenAt: at, openCount: 1 }) ?? "", /^👁 Opened [^·]+$/);
  assert.match(seenLabel({ type: "email", direction: "outbound", seenAt: at, openCount: 3 }) ?? "", /^👁 Opened .+ · 3×$/);
  assert.match(seenLabel({ type: "whatsapp", direction: "outbound", seenAt: at }) ?? "", /^👁 Read /);
});

test("every timeline shows it: Live timeline, Communications tab, and the fleet rollup's fields", () => {
  assert.match(src("src/lib/fleetRollup.ts"), /seenAt: true,\s*openCount: true,/);
  assert.match(src("src/components/CommsTimeline.tsx"), /\{seenLabel\(c\)\}/);
  assert.match(src("src/components/LeadTimeline.tsx"), /seen: seenLabel\(communication\)/);
});
