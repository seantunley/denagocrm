import assert from "node:assert/strict";
import test from "node:test";
import { decodeAndValidateSignaturePng } from "../src/lib/signing/signatureImage";

const VALID_ONE_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("strict signature parser accepts a valid bounded PNG", () => {
  const image = decodeAndValidateSignaturePng(`data:image/png;base64,${VALID_ONE_PIXEL}`);
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.match(image.sha256, /^[a-f0-9]{64}$/);
});

test("strict signature parser rejects MIME tricks and corrupt content", () => {
  assert.throws(() => decodeAndValidateSignaturePng(`data:image/jpeg;base64,${VALID_ONE_PIXEL}`));
  const corrupt = Buffer.from(VALID_ONE_PIXEL, "base64");
  corrupt[corrupt.length - 8] ^= 0xff;
  assert.throws(() => decodeAndValidateSignaturePng(`data:image/png;base64,${corrupt.toString("base64")}`));
  assert.throws(() => decodeAndValidateSignaturePng("data:image/png;base64,not-base64***"));
});
