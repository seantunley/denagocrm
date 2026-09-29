/**
 * Runs once when a server instance starts. Every console method is routed
 * through the log redactor, so the Vercel runtime log never receives an email
 * address, phone number or ID number — from our own console calls, and from
 * what Next.js and libraries print (an unhandled error's message included).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { redactConsole } = await import("@/lib/redactLog");
  redactConsole();
}

/**
 * Catches unhandled errors from server components, actions and routes and
 * files them in the ErrorLog (Settings → System Log).
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string }
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Next uses errors as control flow for redirects/notFound — not failures
  const digest = (err as { digest?: string })?.digest ?? "";
  if (digest.startsWith("NEXT_")) return;
  const { logError } = await import("@/lib/errorLog");
  // `request.path` is the resource path INCLUDING the query string, and the
  // public /signing, /approvals, /s and /api/track routes carry a working
  // credential in it. The System Log is read by workspace owners and platform
  // admins, so the raw path must never be persisted. redactUrl keeps the route
  // shape and drops the token. `logError` redacts again — this is the first of
  // two passes, not the only one.
  const { redactUrl } = await import("@/lib/redactUrl");
  await logError("unhandled", err, `${request.method} ${redactUrl(request.path)}`);
}
