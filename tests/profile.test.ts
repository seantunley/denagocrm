import assert from "node:assert/strict";
import test from "node:test";
import { detectProfileImageMime, isValidPhone, normalisePhone } from "../src/lib/profile";

test("detectProfileImageMime accepts supported image signatures", () => {
  assert.equal(detectProfileImageMime(Uint8Array.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(
    detectProfileImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assert.equal(detectProfileImageMime(new TextEncoder().encode("RIFF0000WEBP")), "image/webp");
});

test("detectProfileImageMime rejects untrusted formats and spoofed content", () => {
  assert.equal(detectProfileImageMime(new TextEncoder().encode("<svg onload=alert(1)>")), null);
  assert.equal(detectProfileImageMime(new TextEncoder().encode("not really a jpeg")), null);
});

test("phone validation keeps international display formatting", () => {
  assert.equal(normalisePhone("  +27 82 123 4567  "), "+27 82 123 4567");
  assert.equal(normalisePhone("   "), null);
  assert.equal(isValidPhone("+27 (82) 123-4567"), true);
  assert.equal(isValidPhone("12"), false);
  assert.equal(isValidPhone("082 call-me"), false);
});
