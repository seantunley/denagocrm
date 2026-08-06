export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { isProductionRuntime, assertSigningRuntimeConfig } = await import("@/lib/signing/securityConfig");
  if (!isProductionRuntime()) return;
  assertSigningRuntimeConfig();
  const { verifyPrivateStorage } = await import("@/lib/storage");
  await verifyPrivateStorage();
}
