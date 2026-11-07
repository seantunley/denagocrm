import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  addWorkingDays,
  defaultChannel,
  handledToday,
  nextStepDefault,
  textToEmailHtml,
  todayChannels,
  todayDrafts,
} from "../src/lib/todayAction";

const src = (rel: string) => readFileSync(rel, "utf8");
// Friday 6 Nov 2026, 12:00 in Johannesburg.
const NOW = new Date("2026-11-06T10:00:00Z");

const base = {
  email: "jo@example.com",
  phone: "+27821234567",
  lastWhatsAppInboundAt: null as Date | null,
  canWriteRecord: true,
  canWhatsApp: true,
  smtpConfigured: true,
  whatsappConfigured: true,
  now: NOW,
};

test("WhatsApp is offered only inside WhatsApp's 24 hours, and says why not", () => {
  const closed = todayChannels(base);
  assert.equal(closed.whatsapp.ok, false);
  assert.match(!closed.whatsapp.ok ? closed.whatsapp.reason : "", /24 hours/);
  const open = todayChannels({ ...base, lastWhatsAppInboundAt: new Date(NOW.getTime() - 3 * 3600_000) });
  assert.equal(open.whatsapp.ok, true);
});

test("each channel names the reason it can't be used", () => {
  const none = todayChannels({ ...base, email: null, phone: null, smtpConfigured: false, canWriteRecord: false, canWhatsApp: false });
  for (const channel of ["call", "email", "whatsapp"] as const) {
    assert.equal(none[channel].ok, false);
    assert.ok(!none[channel].ok && none[channel].reason.length > 0);
  }
  assert.match(!todayChannels({ ...base, email: null }).email.ok ? (todayChannels({ ...base, email: null }).email as { reason: string }).reason : "", /No email address/);
});

test("the row opens on the channel its action asks for, else the next usable one", () => {
  const all = todayChannels({ ...base, lastWhatsAppInboundAt: new Date(NOW.getTime() - 3600_000) });
  assert.equal(defaultChannel("Make first contact", all), "call");
  assert.equal(defaultChannel("Follow up on the quote", all), "email");
  assert.equal(defaultChannel("Reply to their message", all), "whatsapp");
  // Outside the window a reply falls back to email.
  assert.equal(defaultChannel("Reply to their message", todayChannels(base)), "email");
});

test("drafts carry the deal's context", () => {
  const quote = todayDrafts({ action: "Follow up on the quote", firstName: "Jo", opportunity: "Nomad XL", quoteNumber: 1029, senderFirstName: "Sam", company: "Denago Cape Town" });
  assert.match(quote.email.subject, /Q-1029/);
  assert.match(quote.email.body, /^Hi Jo,/);
  assert.match(quote.whatsapp, /Sam from Denago Cape Town/);
  const first = todayDrafts({ action: "Make first contact", firstName: "Jo", opportunity: "Nomad XL", quoteNumber: null, senderFirstName: "Sam", company: "Denago" });
  assert.match(first.email.subject, /Your enquiry about the Nomad XL/);
});

test("email text is escaped into paragraphs", () => {
  assert.equal(textToEmailHtml("Hi <b>Jo</b>,\n\nLine one\nline two"), "<p>Hi &lt;b&gt;Jo&lt;/b&gt;,</p><p>Line one<br>line two</p>");
});

test("the next step skips the weekend", () => {
  // Saturday 7 Nov, or Friday 6 Nov, + 1 working day = Monday 9 Nov; Friday + 3 = Wednesday 11 Nov.
  assert.equal(addWorkingDays(new Date("2026-11-07T08:00:00Z"), 1), "2026-11-09");
  assert.equal(addWorkingDays(NOW, 1), "2026-11-09");
  assert.equal(nextStepDefault("Follow up on the quote", NOW, 7).date, "2026-11-11");
  assert.match(nextStepDefault("Follow up on the quote", NOW, 7).summary, /Q-7/);
});

test("a deal we reached today leaves Today until tomorrow or their reply", () => {
  const morning = new Date("2026-11-06T07:00:00Z");
  assert.equal(handledToday(morning, null, NOW), true);
  assert.equal(handledToday(morning, new Date("2026-11-06T09:00:00Z"), NOW), false, "they wrote after us");
  assert.equal(handledToday(new Date("2026-11-05T15:00:00Z"), null, NOW), false, "yesterday is not today");
  assert.equal(handledToday(null, null, NOW), false);
});

test("Today's loader drops handled rows; our touch is what WE sent or logged", () => {
  const loader = src("src/lib/leadScoreLoader.ts");
  assert.match(loader, /if \(handledToday\(scored\.ourLastTouchAt, scored\.lastInboundAt, now\)\) continue;/);
  assert.match(loader, /direction: "outbound", \.\.\.contactCommunicationWhere/);
  // A customer's details only reach the composer when the viewer may open that customer.
  assert.match(loader, /const customer = mayOpen\(row\.contactId\) \? row\.contact : null;/);
});

test("the row writes only through the existing guarded actions, and only on a click", () => {
  const row = src("src/components/TodayRow.tsx");
  for (const action of ["addCommunication(form)", "sendWhatsAppMessage(undefined, form)", "sendEmailAction(undefined, form)", "scheduleFollowUp("]) {
    assert.ok(row.includes(action), `uses ${action}`);
  }
  assert.match(row, /onClick=\{run\}/);
  assert.doesNotMatch(row, /useEffect/, "nothing runs on its own");
  assert.match(src("src/app/(app)/today/page.tsx"), /<TodayRow/);
});

test("WhatsApp's 24-hour window reads only customers the viewer may open", () => {
  const page = src("src/app/(app)/today/page.tsx");
  assert.match(page, /const openableContacts = await getAccessibleContactIds\(user\);/);
  assert.match(page, /openableContacts === null \|\| openableContacts\.includes\(id as string\)/);
  assert.match(page, /where: \{ contactId: \{ in: contactIds \}, type: "whatsapp", direction: "inbound" \}/);
});

test("a WhatsApp leaves Today only once it is confirmed sent — queued keeps the row and says so", () => {
  const row = src("src/components/TodayRow.tsx");
  const confirmed = /const WHATSAPP_SENT = "([^"]+)";/.exec(row)?.[1];
  assert.ok(confirmed, "the row names the confirmed answer");
  assert.ok(
    src("src/lib/messageDelivery.ts").includes(`if (state.status === "sent") return { ok: "${confirmed}" };`),
    "…and it is the delivery code's own",
  );
  assert.match(row, /if \(channel === "whatsapp" && result\.ok !== WHATSAPP_SENT\) \{\s+setNotice\(/);
  assert.doesNotMatch(row.slice(row.indexOf("setNotice(`"), row.indexOf("const did =")), /setDone\(true\)/);
});
