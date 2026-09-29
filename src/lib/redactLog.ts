import { inspect } from "node:util";
import { redactUrl } from "./redactUrl";

/**
 * Takes client information out of anything written to a log.
 *
 * Logs (Settings → System Log, and the Vercel runtime log the console writes
 * to) must not contain client information. Call sites should not put it there,
 * but a thrown error quotes whatever it was handed — an SMTP rejection names the
 * recipient, a WhatsApp API error names the phone number — so the rule is
 * enforced where logs are WRITTEN, not left to each of the ~130 call sites.
 *
 * What a pattern can recognise is redacted here: email addresses, phone numbers,
 * South African ID numbers, messaging-platform user ids (Messenger/Instagram), and
 * (via redactUrl) credential tokens in links. A
 * NAME cannot be recognised by pattern, so call sites log record ids, never
 * names — that part is enforced by review and by tests on the known writers.
 *
 * Pure apart from `util.inspect`; unit-tested.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Phone numbers: international (+ and 9–15 digits, spaces/dashes/brackets
 * allowed), South African local (0XX XXX XXXX) and South African without the
 * plus (27XXXXXXXXX — how WhatsApp addresses a number). Word boundaries keep it
 * off ids, timestamps and stack-trace line numbers.
 */
const PHONE = /\+\d[\d\s().-]{7,17}\d|\b0[1-9]\d(?:[\s-]?\d){7}\b|\b27[1-9]\d{8}\b/g;

/** 13 digits that read as a South African ID: YYMMDD, then 7 more. */
const SA_ID_SHAPE = /\b\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}\b/g;

/**
 * A customer's id on a messaging platform: a Messenger PSID or Instagram-scoped
 * id is 15–17 digits. Those are what the bot outbox put in production's System
 * Log (as the conversation key). No id or timestamp of ours is that long, and a
 * card number would be caught too.
 */
const PLATFORM_USER_ID = /\b\d{15,20}\b/g;

/** The ID number's last digit is a Luhn check digit; a timestamp rarely passes it. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactForLog(text: string): string {
  return redactUrl(text)
    .replace(EMAIL, "[email]")
    .replace(PLATFORM_USER_ID, "[user-id]")
    .replace(SA_ID_SHAPE, (match) => (luhnValid(match) ? "[id-number]" : match))
    .replace(PHONE, "[phone]");
}

/** One console argument, redacted. Non-strings are rendered first, so nothing slips through as an object. */
export function redactLogArg(arg: unknown): unknown {
  if (typeof arg === "string") return redactForLog(arg);
  if (arg === null || arg === undefined || typeof arg === "number" || typeof arg === "boolean") return arg;
  if (arg instanceof Error) return redactForLog(arg.stack ?? `${arg.name}: ${arg.message}`);
  return redactForLog(inspect(arg, { depth: 4, breakLength: Infinity }));
}

const PATCHED = Symbol.for("denagocrm.console.redacted");
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

/**
 * Route every console method through {@link redactLogArg}. Installed once at
 * server start (instrumentation.ts), so it also covers what Next.js and
 * libraries print — an unhandled error's message included — not only our own
 * console calls. Idempotent.
 */
export function redactConsole(target: Console = console): void {
  const marked = target as Console & { [PATCHED]?: boolean };
  if (marked[PATCHED]) return;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(redactLogArg));
  }
  marked[PATCHED] = true;
}
