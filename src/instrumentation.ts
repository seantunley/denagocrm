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
  await logError("unhandled", err, `${request.method} ${request.path}`);
}
