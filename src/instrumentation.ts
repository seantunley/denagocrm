export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { isProductionRuntime, assertSigningRuntimeConfig } = await import("@/lib/signing/securityConfig");
  if (!isProductionRuntime()) return;
  assertSigningRuntimeConfig();
  const { verifyPrivateStorage } = await import("@/lib/storage");
  await verifyPrivateStorage();
}

/**
 * Catches unhandled errors from server components, actions and routes and files
 * them in the System Log. Public capability tokens are redacted before storage.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const digest = (err as { digest?: string })?.digest ?? "";
  if (digest.startsWith("NEXT_")) return;
  const [{ logError }, { redactUrl }] = await Promise.all([
    import("@/lib/errorLog"),
    import("@/lib/redactUrl"),
  ]);
  await logError("unhandled", err, `${request.method} ${redactUrl(request.path)}`);
}
