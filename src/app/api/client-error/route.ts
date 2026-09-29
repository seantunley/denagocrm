import { NextResponse } from "next/server";
import { z } from "zod";
import { oneLine } from "@/lib/logSafe";
import { logError } from "@/lib/errorLog";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import {
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
  type RateLimitPolicy,
} from "@/lib/rateLimit";

/**
 * Where a CLIENT-side crash gets recorded.
 *
 * A server error is replaced by an opaque digest in production and logged server
 * side under that digest, so support has a handle on it. A client error has no
 * such path: React generates no digest, nothing reaches any log, and the only
 * record is a console message in a browser the user has already navigated away
 * from. That is how a dashboard crash reached a real person and left nothing to
 * read afterwards — the error page itself showed no reference, because there was
 * no digest to show.
 *
 * app/(app)/error.tsx posts here so there is something to read.
 *
 * ── WHY THIS IS NOT AN OPEN LOG SINK ────────────────────────────────────────
 *
 * An endpoint that writes caller-supplied text to a log is a log-flooding and
 * log-forging surface, so:
 *
 *   - It requires a SESSION, via the same requireApiUser every other API route
 *     uses. There is no anonymous reporting; a crash on a public page is out of
 *     scope here and would need its own bounded design.
 *   - It is RATE LIMITED per user. An error boundary can re-render in a loop,
 *     and the report must not become the outage.
 *   - The body is size-capped BEFORE JSON.parse, and every field is
 *     length-capped by the schema.
 *   - Control characters are stripped before logging, so a crafted message
 *     cannot forge a second log line.
 *
 * Reports are filed through logError, so they inherit tenant attribution,
 * redaction, retention and the same Settings → System Log visibility as server
 * failures. Caller text remains bounded and sanitized before it reaches that
 * shared path.
 */

/** Ten reports per five minutes, then a fifteen-minute block. A crash loop hits this at once. */
const CLIENT_ERROR_POLICY: RateLimitPolicy = {
  limit: 10,
  windowMs: 5 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
};

/** Bodies larger than this are refused before JSON.parse ever sees them. */
const MAX_BODY_BYTES = 8 * 1024;

const reportSchema = z.object({
  digest: z.string().max(120).nullish(),
  message: z.string().max(1000).default(""),
  stack: z.string().max(4000).nullish(),
  path: z.string().max(300).nullish(),
});


export async function POST(request: Request) {
  let user;
  try {
    user = await requireApiUser();
  } catch (err) {
    // The same 401/403 shape every other API route returns — this endpoint does
    // not get its own auth dialect.
    return (
      apiAuthErrorResponse(err) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );
  }

  const limit = await registerRateLimitAttempt(
    rateLimitKey("client-error", user.id),
    CLIENT_ERROR_POLICY,
  );
  // 204 rather than 429 throughout: the browser will not act on any of these,
  // and the error page must not surface a second failure on top of the one it is
  // already reporting.
  if (!limit.allowed) return new NextResponse(null, { status: 204 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new NextResponse(null, { status: 204 });

  let report;
  try {
    const parsed = reportSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return new NextResponse(null, { status: 204 });
    report = parsed.data;
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const ip = await getRequestIp();

  const message = oneLine(report.message || "Unknown client error", 500);
  const clientError = new Error(message);
  if (report.stack) clientError.stack = oneLine(report.stack, 4000).replace(/ at /g, "\n    at ");

  await logError(
    "client-error",
    clientError,
    `user=${user.id} ip=${ip} path=${oneLine(report.path ?? "unknown", 300)} ` +
      `digest=${report.digest ? oneLine(report.digest, 120) : "none"}`,
    { alert: false },
  );

  return new NextResponse(null, { status: 204 });
}
