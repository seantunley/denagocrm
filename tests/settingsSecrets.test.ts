import test from "node:test";
import assert from "node:assert/strict";
import {
  keepBlankSubmit,
  isManagedSecret,
  isRegeneratable,
} from "../src/lib/settingsSecrets";

test("keepBlankSubmit: blank + keepIfBlank → keep (skip the write)", () => {
  assert.equal(keepBlankSubmit("", true), true);
});

test("keepBlankSubmit: a new value + keepIfBlank → rotate (write it)", () => {
  assert.equal(keepBlankSubmit("sk-new-secret", true), false);
});

test("keepBlankSubmit: blank without keepIfBlank → write (non-secret field can clear)", () => {
  assert.equal(keepBlankSubmit("", false), false);
});

test("isManagedSecret: allowlists the integration secrets, rejects arbitrary keys", () => {
  for (const key of [
    "SMTP_PASS",
    "IMAP_PASS",
    "META_PAGE_ACCESS_TOKEN",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
    "WA_ACCESS_TOKEN",
    "GOOGLE_PLACES_API_KEY",
    "BULKSMS_TOKEN_SECRET",
    "ANTHROPIC_API_KEY",
    "INTAKE_API_KEY",
    "ELEVENLABS_API_KEY",
  ]) {
    assert.equal(isManagedSecret(key), true, `${key} should be managed`);
  }
  for (const key of ["SETTINGS_ENCRYPTION_KEY", "CRON_SECRET", "SESSION_IDLE_MINUTES", "", "../etc"]) {
    assert.equal(isManagedSecret(key), false, `${key} must NOT be clearable/revealable`);
  }
});

test("isRegeneratable: only secrets we generate — never externally-issued credentials", () => {
  assert.equal(isRegeneratable("META_VERIFY_TOKEN"), true);
  assert.equal(isRegeneratable("INTAKE_API_KEY"), true);
  for (const key of ["SMTP_PASS", "WA_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "GOOGLE_PLACES_API_KEY"]) {
    assert.equal(isRegeneratable(key), false, `${key} must not be regeneratable`);
  }
});
