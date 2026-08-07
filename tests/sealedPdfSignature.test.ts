import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";

/**
 * `seal.ts` reaches `securityPolicy.ts`, which is `server-only` — a marker
 * package Next vendors through an RSC export condition and which is therefore
 * not installed for the unit runner. Same interception the retention suite uses,
 * so these stay BEHAVIOURAL tests of the shipped function rather than another
 * source scan.
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

const { sealPdf, sealedPdfSignature } = createRequire(import.meta.url)(
  "../src/lib/pdf/seal.ts",
) as typeof import("../src/lib/pdf/seal");
const { trimToDerLength } = createRequire(import.meta.url)(
  "../src/lib/signing/cms.ts",
) as typeof import("../src/lib/signing/cms");

/**
 * Does the seal actually seal THESE bytes?
 *
 * The artifact validator recorded a certificate and a stored hash and called
 * that verified. The hash only ever proved the blob had not changed since we
 * filed it; nothing checked that the certificate it named had sealed the
 * document at all. These tests seal a real PDF and then attack it, because a
 * source-level assertion cannot tell the difference between code that verifies a
 * signature and code that merely looks like it does.
 *
 * The identity here is the DEVELOPMENT one — self-signed, deliberately outside
 * any trust store — so `contentVerified` and `trusted` are exercised as the
 * separate questions they are.
 */

/**
 * The instant the seal must have been valid at. The development certificate is
 * minted at process start with a one-year window, so "now" is inside it — which
 * keeps these tests about the SIGNATURE rather than about clock arithmetic.
 */
const AT = new Date();

async function sealedDocument(): Promise<Buffer> {
  // These tests are ABOUT the development identity, so make sure that is what
  // signs. sealValidationInstant.test.ts configures a PKCS#12 with a deliberately
  // narrow validity window at module scope; when both files share a process that
  // leaked in here and the seal was made by a certificate that expired months
  // ago, so "not trusted because self-signed" arrived as "not valid at the
  // attested time" — the right refusal for the wrong reason. A test that depends
  // on which file loaded first is not a test.
  delete process.env.BUILDER_SIGN_P12_BASE64;
  delete process.env.BUILDER_SIGN_P12_PASSPHRASE;

  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  return sealPdf(bytes, { reason: "test", name: "Test Signer" });
}

test("a genuine seal verifies over the bytes the PDF declares", async () => {
  const sealed = await sealedDocument();
  const result = sealedPdfSignature(sealed, AT);

  assert.ok(result, "a sealed PDF must be readable");
  assert.equal(result.contentVerified, true, result.reason ?? "");
  // The certificate is read OUT OF THE FILE, so it describes what sealed this
  // document rather than whatever is configured at validation time.
  assert.match(result.certificate.subject, /Denago Development Seal/);
  assert.match(result.certificate.fingerprintSha256, /^[0-9a-f]{64}$/);
});

test("the development identity is NOT reported as trusted", () => {
  // The two questions are separate. A self-signed seal can be perfectly valid
  // over its bytes and still be an identity nobody should rely on — which is
  // exactly why strict mode refuses it and compat mode does not.
  return sealedDocument().then((sealed) => {
    const result = sealedPdfSignature(sealed, AT);
    assert.ok(result);
    assert.equal(result.certificate.trusted, false);
    assert.match(String(result.reason ?? ""), /trusted root|certificate authority/);
  });
});

test("one altered byte in the signed content breaks the seal", async () => {
  const sealed = await sealedDocument();
  // Change a byte inside the covered range — the document's own content, not the
  // signature blob. The stored SHA-256 would catch a change we made after
  // filing; it would NOT catch a document that was never sealed by this
  // certificate in the first place.
  const tampered = Buffer.from(sealed);
  // Well inside the first covered range and well before the /ByteRange entry
  // itself, so the file still parses and only its CONTENT differs.
  const at = 100;
  tampered[at] ^= 0xff;

  const result = sealedPdfSignature(tampered, AT);
  assert.ok(result, "the certificate is still readable");
  assert.equal(result.contentVerified, false, "an altered document must not verify");
});

test("content appended after sealing is not treated as sealed", async () => {
  const sealed = await sealedDocument();
  // The ByteRange stops where the file used to end. Anything after it was added
  // afterwards and the signature says nothing about it — accepting the file
  // regardless is how a signed contract acquires pages nobody signed.
  const extended = Buffer.concat([sealed, Buffer.from("\n% appended after signing\n", "latin1")]);

  const result = sealedPdfSignature(extended, AT);
  assert.ok(result);
  assert.equal(result.contentVerified, false);
  assert.match(String(result.reason ?? ""), /appended after/);
});

/** The ByteRange the file declares, and the unsigned gap it leaves. */
function byteRange(pdf: Buffer): { a: number; b: number; c: number; d: number } {
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(pdf.toString("latin1"));
  assert.ok(m, "a sealed PDF must declare a ByteRange");
  const [a, b, c, d] = m!.slice(1, 5).map(Number);
  return { a, b, c, d };
}

test("content smuggled into the unsigned gap is refused", async () => {
  const sealed = await sealedDocument();
  const { a, b, c } = byteRange(sealed);

  // THE ATTACK. Every byte between the two covered ranges is unsigned, and the
  // gap is ~16 KB of placeholder. The signature is left completely intact: the
  // hex is closed early at its true DER length and the freed space is filled
  // with content nobody signed. A verifier that only asks "is there a
  // /Contents <…> somewhere in the gap?" accepts this — the signature verifies,
  // the certificate is genuine, and several kilobytes ride along inside the file.
  const gap = sealed.subarray(a + b, c).toString("latin1");
  const allHex = gap.slice(1, -1).replace(/[^0-9a-fA-F]/g, "");
  const realDer = trimToDerLength(Buffer.from(allHex, "hex"));
  const realHex = allHex.slice(0, realDer.length * 2);

  const injected = "\n% an object nobody signed\n";
  const head = `<${realHex}>${injected}`;
  assert.ok(head.length < gap.length, "the placeholder must leave room to smuggle");
  const rebuilt = head + " ".repeat(gap.length - head.length);
  assert.equal(rebuilt.length, gap.length, "the gap size is fixed by the SIGNED ByteRange");

  const tampered = Buffer.concat([
    sealed.subarray(0, a + b),
    Buffer.from(rebuilt, "latin1"),
    sealed.subarray(c),
  ]);
  assert.equal(tampered.length, sealed.length);

  const result = sealedPdfSignature(tampered, AT);
  assert.ok(result, "the certificate is still readable — this is a tampered seal, not an unsigned file");
  assert.equal(result.contentVerified, false, "the unsigned gap must hold nothing but the signature");
  assert.match(String(result.reason ?? ""), /unsigned gap/);
});

test("a file with no signature is reported as unsigned, not as unverified", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const unsigned = Buffer.from(await pdf.save({ useObjectStreams: false }));

  // null means "there is nothing here to check", which the caller records as its
  // own error. Returning a certificate with contentVerified:false would imply a
  // seal exists and failed.
  assert.equal(sealedPdfSignature(unsigned, AT), null);
});
