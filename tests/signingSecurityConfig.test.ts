import assert from "node:assert/strict";
import test from "node:test";
import { validateSigningRuntimeConfig } from "../src/lib/signing/securityConfig";

const production = {
  VERCEL_ENV: "production",
  BLOB_PRIVATE: "true",
  BLOB_PRIVATE_READ_WRITE_TOKEN: "blob",
  TENANT_ENFORCEMENT: "enforce",
  SIGNING_TOKEN_ENCRYPTION_KEY: "key",
  SIGNING_IDENTITY_SESSION_SECRET: "identity",
  SIGNING_TRUST_SERVICE_URL: "https://trust.example",
  SIGNING_TRUST_SERVICE_TOKEN: "trust",
  SIGNING_ANCHOR_URL: "https://anchor.example",
  SIGNING_ANCHOR_TOKEN: "anchor",
  SIGNING_RELEASE_ID: "commit",
  SIGNING_IDENTITY_DEFAULT: "ES2_EMAIL_OTP",
} as NodeJS.ProcessEnv;

test("production preflight fails closed when trust controls are absent", () => {
  const errors = validateSigningRuntimeConfig({ VERCEL_ENV: "production" });
  assert.ok(errors.length >= 7);
  assert.ok(errors.some((error) => error.includes("private")));
  assert.ok(errors.some((error) => error.includes("trust service")));
});

test("fully configured production signing passes preflight", () => {
  assert.deepEqual(validateSigningRuntimeConfig(production), []);
});

test("SMS assurance cannot be selected without a real SMS provider", () => {
  const errors = validateSigningRuntimeConfig({ ...production, SIGNING_IDENTITY_DEFAULT: "ES2_SMS_OTP" });
  assert.ok(errors.some((error) => error.includes("SIGNING_SMS_SERVICE_URL")));
});
