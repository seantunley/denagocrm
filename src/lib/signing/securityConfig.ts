import "server-only";

type EnvLike = Record<string, string | undefined>;

export type SigningRuntimeConfig = {
  production: boolean;
  privateStorage: boolean;
  privateStorageToken: boolean;
  tenantEnforcement: boolean;
  tokenEncryptionKey: boolean;
  identitySessionSecret: boolean;
  trustServiceUrl: boolean;
  trustServiceToken: boolean;
  anchorServiceUrl: boolean;
  anchorServiceToken: boolean;
  releaseId: boolean;
  smsService: boolean;
  defaultIdentityPolicy: string;
};

export function isProductionRuntime(env: EnvLike = process.env): boolean {
  return env.VERCEL_ENV === "production" || env.APP_ENV === "production" || env.DENAGO_PRODUCTION === "true";
}

export function inspectSigningRuntimeConfig(env: EnvLike = process.env): SigningRuntimeConfig {
  return {
    production: isProductionRuntime(env),
    privateStorage: env.BLOB_PRIVATE === "true",
    privateStorageToken: Boolean(env.BLOB_PRIVATE_READ_WRITE_TOKEN),
    tenantEnforcement: env.TENANT_ENFORCEMENT === "enforce",
    tokenEncryptionKey: Boolean(env.SIGNING_TOKEN_ENCRYPTION_KEY),
    identitySessionSecret: Boolean(env.SIGNING_IDENTITY_SESSION_SECRET || env.SIGNING_TOKEN_ENCRYPTION_KEY),
    trustServiceUrl: Boolean(env.SIGNING_TRUST_SERVICE_URL),
    trustServiceToken: Boolean(env.SIGNING_TRUST_SERVICE_TOKEN),
    anchorServiceUrl: Boolean(env.SIGNING_ANCHOR_URL),
    anchorServiceToken: Boolean(env.SIGNING_ANCHOR_TOKEN),
    releaseId: Boolean(env.SIGNING_RELEASE_ID || env.VERCEL_GIT_COMMIT_SHA),
    smsService: Boolean(env.SIGNING_SMS_SERVICE_URL && env.SIGNING_SMS_SERVICE_TOKEN),
    defaultIdentityPolicy: env.SIGNING_IDENTITY_DEFAULT || "ES2_EMAIL_OTP",
  };
}

export function validateSigningRuntimeConfig(env: EnvLike = process.env): string[] {
  const c = inspectSigningRuntimeConfig(env);
  if (!c.production) return [];
  const errors: string[] = [];
  if (!c.privateStorage || !c.privateStorageToken) {
    errors.push("production signing requires BLOB_PRIVATE=true and BLOB_PRIVATE_READ_WRITE_TOKEN");
  }
  if (!c.tenantEnforcement) errors.push("production signing requires TENANT_ENFORCEMENT=enforce");
  if (!c.tokenEncryptionKey) errors.push("production signing requires SIGNING_TOKEN_ENCRYPTION_KEY");
  if (!c.identitySessionSecret) errors.push("production signing requires SIGNING_IDENTITY_SESSION_SECRET");
  if (!c.trustServiceUrl || !c.trustServiceToken) {
    errors.push("production sealing requires SIGNING_TRUST_SERVICE_URL and SIGNING_TRUST_SERVICE_TOKEN");
  }
  if (!c.anchorServiceUrl || !c.anchorServiceToken) {
    errors.push("production evidence anchoring requires SIGNING_ANCHOR_URL and SIGNING_ANCHOR_TOKEN");
  }
  if (!c.releaseId) errors.push("production signing requires SIGNING_RELEASE_ID or VERCEL_GIT_COMMIT_SHA");
  if (["ES2_SMS_OTP", "ES2_EMAIL_SMS"].includes(c.defaultIdentityPolicy) && !c.smsService) errors.push("SMS identity policies require SIGNING_SMS_SERVICE_URL and SIGNING_SMS_SERVICE_TOKEN");
  if (c.defaultIdentityPolicy === "ES1_LINK") {
    errors.push("production default identity policy may not be ES1_LINK");
  }
  return errors;
}

export function assertSigningRuntimeConfig(env: EnvLike = process.env): void {
  const errors = validateSigningRuntimeConfig(env);
  if (errors.length) throw new Error(`Signing runtime preflight failed:\n- ${errors.join("\n- ")}`);
}

export const signingReleaseId = () => process.env.SIGNING_RELEASE_ID || process.env.VERCEL_GIT_COMMIT_SHA || "development";
