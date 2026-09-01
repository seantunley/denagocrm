import { NextResponse } from "next/server";
import { oneLine } from "@/lib/logSafe";
import { logError } from "@/lib/errorLog";
import {
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
  type RateLimitPolicy,
} from "@/lib/rateLimit";

/**
 * Where Content-Security-Policy violations are actually collected.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `src/lib/csp.ts` ships a Report-Only policy described in its own comments as
 * "the policy we intend to enforce next" — the resource directives
 * (`default-src`, `img-src`, `connect-src`, `font-src`) that the enforced policy
 * still omits. It has been running in production for months and reported to
 * NOBODY: without a `report-uri`, a Report-Only policy writes a line to each
 * visitor's console and nothing else. So the question it exists to answer —
 * "would enforcing this break anything?" — had no data behind it, and promoting
 * it would have been a guess wearing a plan's clothing.
 *
 * An OWASP ZAP scan flagged the missing resource directives as a real gap. It is
 * right, and this is the first half of closing it: collect first, promote on
 * evidence. Enforcing blind is how a CSP takes a working site down.
 *
 * ── WHY IT IS UNAUTHENTICATED, AND WHAT THAT COSTS ──────────────────────────
 *
 * It has to be. A browser posts a violation report with no credentials, and the
 * violations that matter most happen on `/login`, where there is no session to
 * authenticate with. `/api/client-error` can require a user; this cannot.
 *
 * That makes it a public write endpoint, so it is bounded on every axis that
 * matters: POST only, a hard byte cap read before parsing, per-IP rate limiting
 * (through `getRequestIp`, whose spoofable-header bug was fixed alongside this),
 * a fixed set of extracted fields rather than the whole report, and truncation
 * on each. It never echoes input and always answers 204 — a reporter must learn
 * nothing from it, including whether it was throttled.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CSP_REPORT_POLICY: RateLimitPolicy = {
  limit: 30,
  windowMs: 5 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

/** A violation report is a few short strings; anything larger is not one. */
const MAX_BODY_BYTES = 8 * 1024;

/** Field lengths generous enough for a real URL and mean enough to bound a log row. */
const trim = (value: unknown, max: number): string =>
  typeof value === "string" ? oneLine(value, max) : "";

/**
 * Pull the three fields worth acting on out of either wire format.
 *
 * `report-uri` posts `{"csp-report": {...}}` with hyphenated keys; the newer
 * `report-to` posts an ARRAY of `{type, body}` with camelCase. Both are accepted
 * because both are configured, and a collector that understands only one of them
 * silently loses half the reports.
 */
function violationsFrom(payload: unknown): Array<{ directive: string; blocked: string; document: string }> {
  const out: Array<{ directive: string; blocked: string; document: string }> = [];
  const push = (raw: Record<string, unknown> | undefined) => {
    if (!raw) return;
    const directive = trim(raw["effective-directive"] ?? raw["violated-directive"] ?? raw.effectiveDirective, 100);
    const blocked = trim(raw["blocked-uri"] ?? raw.blockedURL, 300);
    const document = trim(raw["document-uri"] ?? raw.documentURL, 300);
    if (directive || blocked) out.push({ directive, blocked, document });
  };

  if (Array.isArray(payload)) {
    for (const entry of payload.slice(0, 10)) {
      const item = entry as { type?: unknown; body?: unknown };
      if (item?.type === "csp-violation" || item?.type === "csp") push(item.body as Record<string, unknown>);
    }
    return out;
  }
  push((payload as { "csp-report"?: Record<string, unknown> })?.["csp-report"]);
  return out;
}

export async function POST(request: Request) {
  // Read as text with a cap BEFORE parsing: `request.json()` on a hostile body
  // is the parse this endpoint must not perform.
  const raw = await request.text().catch(() => "");
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

  const limit = await registerRateLimitAttempt(
    rateLimitKey("csp-report", await getRequestIp()),
    CSP_REPORT_POLICY,
  );
  if (!limit.allowed) return new NextResponse(null, { status: 204 });

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  for (const violation of violationsFrom(payload)) {
    // Deliberately one row per violation, and deliberately terse. The point is
    // to answer "which directive would break, and on what" often enough to see a
    // pattern — not to reconstruct a session.
    await logError(
      "csp-violation",
      `${violation.directive || "unknown directive"} blocked ${violation.blocked || "(inline)"}`,
      violation.document || undefined,
    ).catch(() => {});
  }

  // Always 204, throttled or not, parsed or not. The browser ignores the body,
  // and a reporter learns nothing about the endpoint from its answer.
  return new NextResponse(null, { status: 204 });
}
