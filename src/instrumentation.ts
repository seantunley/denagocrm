export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { isProductionRuntime, validateSigningRuntimeConfig, assertSigningRuntimeConfig } = await import("@/lib/signing/securityConfig");
  if (!isProductionRuntime()) return;

  const errors = validateSigningRuntimeConfig();
  if (errors.length) {
    console.warn("[signing] signing operations are unavailable until runtime prerequisites are configured", { errors });
  }

  // App boot must not be held hostage by optional signing infrastructure. Teams
  // may opt into a deployment-wide hard gate only after the private store, trust
  // service and evidence anchor have been provisioned and verified.
  if (process.env.SIGNING_STRICT_BOOT !== "true") return;
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