import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import forge from "node-forge";
import { PDFDocument } from "pdf-lib";

/**
 * Certificate validity is a question about an INSTANT, and which instant you
 * pick decides the answer.
 *
 * The validator used to pass the signer's own `notBefore` — asking a certificate
 * whether it was valid on the first day it was valid, which cannot answer no. An
 * identity that expired years before a document was sealed still came back
 * trusted, and the seal is what a contract rests on.
 *
 * These tests build a certificate with a KNOWN, narrow validity window, seal a
 * document with it, and then ask the validator the same question at two
 * different instants. One inside the window, one after it. The answers must
 * differ — that is the whole property, and no source assertion can show it.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const YEAR = 365 * 24 * 60 * 60 * 1000;
const PASSPHRASE = "test-identity";

/** A PKCS#12 identity whose certificate is valid only across a given window. */
function identityValidBetween(notBefore: Date, notAfter: Date): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "07";
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: "commonName", value: "Window Test Seal" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSPHRASE, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64");
}

/**
 * The module caches nothing about the configured identity across calls, but it
 * DOES read the environment at call time — so the variables are set before the
 * module is required and left in place for the whole file.
 */
const SEALED_AT = new Date(Date.now() - 18 * (YEAR / 12)); // 18 months ago
process.env.BUILDER_SIGN_P12_BASE64 = identityValidBetween(
  new Date(SEALED_AT.getTime() - YEAR / 12),
  new Date(SEALED_AT.getTime() + YEAR / 12),
);
process.env.BUILDER_SIGN_P12_PASSPHRASE = PASSPHRASE;

const { sealPdf, sealedPdfSignature } = createRequire(import.meta.url)(
  "../src/lib/pdf/seal.ts",
) as typeof import("../src/lib/pdf/seal");

async function sealedDocument(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  return sealPdf(bytes, { reason: "test", name: "Window Test" });
}

test("the seal is trusted when checked at the instant it was made", async () => {
  const sealed = await sealedDocument();
  const result = sealedPdfSignature(sealed, SEALED_AT);

  assert.ok(result);
  assert.equal(result.contentVerified, true, result.reason ?? "");
  // Inside the certificate's window, so the identity stands behind it.
  assert.equal(result.certificate.trusted, true, result.reason ?? "");
});

test("the same seal is NOT trusted when the certificate had already expired", async () => {
  const sealed = await sealedDocument();
  // A year after the window closed — which is where `new Date()` would land for
  // any historic document, and where the signer's own notBefore never lands.
  const result = sealedPdfSignature(sealed, new Date(SEALED_AT.getTime() + YEAR));

  assert.ok(result);
  // The BYTES are still sealed by this certificate — that does not change with
  // time. Only whether the identity was valid then.
  assert.equal(result.contentVerified, true, result.reason ?? "");
  assert.equal(result.certificate.trusted, false);
  assert.match(String(result.reason ?? ""), /not valid when this document was sealed/);
});

test("a certificate is not trusted before it was issued either", async () => {
  const sealed = await sealedDocument();
  const result = sealedPdfSignature(sealed, new Date(SEALED_AT.getTime() - YEAR));
  assert.ok(result);
  assert.equal(result.certificate.trusted, false);
});

test("strict mode refuses to seal with a certificate that is not valid now", async () => {
  // Signing with an expired key produces a perfectly valid signature and a
  // document that only reports as untrusted later, when somebody validates it.
  // By then it is on a contract. Readiness checked that a PKCS#12 exists; it
  // never asked whether it was still in date.
  const previous = { ...process.env };
  // Everything else strict mode demands, so the refusal under test is the
  // CERTIFICATE's — not the readiness list shadowing it.
  Object.assign(process.env, {
    SIGNING_SECURITY_MODE: "strict",
    BLOB_PRIVATE: "true",
    BLOB_PRIVATE_READ_WRITE_TOKEN: "test-token",
    SETTINGS_ENCRYPTION_KEY: "0".repeat(64),
    SIGNING_OTP_SECRET: "test-signing-otp-secret-at-least-thirty-two",
    SIGN_BASE_URL: "https://sign.example.invalid",
    CRON_SECRET: "test-cron-secret",
    BUILDER_SIGN_P12_BASE64: identityValidBetween(
      new Date(Date.now() - 2 * YEAR),
      new Date(Date.now() - YEAR),
    ),
  });
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    await assert.rejects(
      () => sealPdf(bytes, { reason: "test", name: "Expired" }),
      /expired on/,
      "strict mode must refuse an expired signing identity",
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
