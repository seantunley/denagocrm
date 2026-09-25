import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { redactConsole, redactForLog, redactLogArg } from "../src/lib/redactLog";

/**
 * Logs must not contain client information.
 *
 * Enforced where logs are written — the System Log writer and the server console
 * — because an error quotes whatever it was handed, and ~130 call sites cannot
 * each be trusted to remember. Names can't be recognised by pattern, so the
 * known writers are also tested for logging ids instead.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/* ── what is redacted ─────────────────────────────────────────────── */

test("EMAIL ADDRESSES, PHONE NUMBERS AND ID NUMBERS ARE REDACTED", () => {
  const cases: Array<[string, string]> = [
    ["550 5.1.1 <gavin.tagg@example.co.za>: Recipient address rejected", "550 5.1.1 <[email]>: Recipient address rejected"],
    ["to: sales+quotes@denago.co.za, g@x.io", "to: [email], [email]"],
    ["WhatsApp: recipient 27821234567 not in allowed list", "WhatsApp: recipient [phone] not in allowed list"],
    ["call +27 82 123 4567 back", "call [phone] back"],
    ["call +27821234567 back", "call [phone] back"],
    ["mobile 082 123 4567", "mobile [phone]"],
    ["mobile 082-123-4567", "mobile [phone]"],
    ["mobile 0821234567.", "mobile [phone]."],
    ["UK +44 20 7946 0958", "UK [phone]"],
    ["ID 8001015009087 on file", "ID [id-number] on file"],
    // The real shape found in production's System Log: the bot outbox's context
    // `channel:conversationKey:outboxId:failureCode`, where the key is the
    // customer's Messenger/Instagram id (17 digits). Not a phone number.
    ["messenger:24681357913579246:cmtmsv4i20005gm0ar2f14nd9:provider_error", "messenger:[user-id]:cmtmsv4i20005gm0ar2f14nd9:provider_error"],
    ["instagram:178414123456789:c1:rate_limited", "instagram:[user-id]:c1:rate_limited"],
  ];
  for (const [input, expected] of cases) assert.equal(redactForLog(input), expected, input);
});

test("…BUT IDS, TIMESTAMPS AND STACK TRACES SURVIVE, so the log still diagnoses", () => {
  const keep = [
    "quote=cmr9dfzuj0001jo044ztn87yz photo=3",
    "outbox whatsapp:cms5vq4dr0000o24wm4thj0js:rate_limited",
    "2026-09-25T14:59:24.000Z took 1234ms",
    "at resolveUpload (C:\\app\\src\\app\\actions\\library.ts:81:11)",
    "created 1790349854880", // epoch ms: 13 digits, not a valid ID date
    "created 1801234567890", // epoch ms that reads as a date, rejected by the ID check digit
    "Anthropic API 529: overloaded",
    "SMTP code 535",
    "uuid 3f2b9c1e-8a4d-4c6b-9e21-7d5a0b1c2d3e",
    "Q-1010 total R 1 234 567.00",
  ];
  for (const text of keep) assert.equal(redactForLog(text), text, text);
});

test("credential links are still stripped (redactForLog includes redactUrl)", () => {
  const out = redactForLog("GET /signing/abcDEF123456789012345678901234567890 failed");
  assert.ok(!out.includes("abcDEF1234567890"), out);
});

/* ── where it is enforced ─────────────────────────────────────────── */

test("THE SERVER CONSOLE IS REDACTED — strings, errors and objects alike", () => {
  const seen: unknown[][] = [];
  const fake = {
    log: (...a: unknown[]) => seen.push(a),
    info: (...a: unknown[]) => seen.push(a),
    warn: (...a: unknown[]) => seen.push(a),
    error: (...a: unknown[]) => seen.push(a),
    debug: (...a: unknown[]) => seen.push(a),
    trace: (...a: unknown[]) => seen.push(a),
  } as unknown as Console;
  redactConsole(fake);
  redactConsole(fake); // idempotent: redacting twice must not double-wrap

  fake.error("Booking failed for", "gavin@example.co.za", new Error("SMS to 0821234567 failed"));
  fake.warn({ contact: { email: "anna@example.com", phone: "+27 82 123 4567" }, id: "c123" });
  fake.log("count", 3, null);

  const printed = JSON.stringify(seen);
  for (const pii of ["gavin@example.co.za", "0821234567", "anna@example.com", "+27 82 123 4567"]) {
    assert.ok(!printed.includes(pii), `${pii} reached the console`);
  }
  assert.match(printed, /c123/, "ids survive");
  assert.deepEqual(seen[2], ["count", 3, null], "non-strings that can't carry client data pass through untouched");
  assert.equal(typeof redactLogArg(new Error("x")), "string", "an Error is rendered, then redacted");
});

test("the console is redacted at server start, and the System Log on every write", () => {
  const instrumentation = src("src/instrumentation.ts");
  assert.match(instrumentation, /export async function register\(\)[\s\S]*?redactConsole\(\);/);
  const errorLog = src("src/lib/errorLog.ts");
  assert.match(errorLog, /const message = redactForLog\(raw\);/);
  assert.match(errorLog, /context: context \? redactForLog\(context\)/);
  // Queue rows and journey traces keep provider errors too; those are logs as well.
  assert.match(src("src/lib/botOutbox.ts"), /const lastError = redactForLog\(error\)\.slice\(0, 1000\);/);
  assert.match(src("src/lib/botInboundEvent.ts"), /const message = redactForLog\(/);
  const journeys = src("src/lib/journeyRuns.ts");
  assert.match(journeys, /const note = args\.note == null \? args\.note : redactForLog\(args\.note\);/);
  assert.match(journeys, /lastError: redactForLog\(message\)\.slice\(0, 1000\),/);
});

test("THE KNOWN WRITERS LOG IDS, NOT CLIENTS — what a pattern can't catch", () => {
  // SMTP logged the recipient and the subject (which often names the customer),
  // SMS the number, and the bot outbox the conversation key — the customer's
  // phone number on WhatsApp, their Messenger/Instagram id elsewhere. That last
  // one put 2 customer ids in production's log.
  const email = src("src/lib/email.ts");
  assert.ok(!/logError\("smtp", err, `[^`]*\$\{input\.(to|subject)\}/.test(email), "no recipient or subject in the SMTP log");
  assert.ok(!/logError\("sms", err, `[^`]*\$\{to\}/.test(src("src/lib/sms.ts")), "no number in the SMS log");
  assert.ok(!/logError\("bot-outbox"[^\n]*\$\{row\.key\}/.test(src("src/lib/botOutbox.ts")), "no conversation key in the outbox log");
});
