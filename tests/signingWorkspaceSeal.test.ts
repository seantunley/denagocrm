import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";

/**
 * A workspace seals its signed documents with ONE certificate of its own.
 *
 * On live the seal fell back, silently, to a certificate made in memory when the
 * server last started — "Denago Development Seal", a different one after every
 * deploy. These seal real PDFs with the kinds of certificate that can now be in
 * play and ask the verifier what it makes of each, because "is this the
 * workspace's certificate?" is a property of the bytes, not of the source.
 */
type Loader = (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { sealPdf, sealedPdfSignature, sealCertificateInfo } = require_("../src/lib/pdf/seal.ts") as typeof import("../src/lib/pdf/seal");
const { selfSignedP12, temporarySealMaterial, serverSealMaterial, TEMPORARY_SEAL_NAME } = require_("../src/lib/signing/sealMaterial.ts") as typeof import("../src/lib/signing/sealMaterial");
type SealMaterial = import("../src/lib/signing/sealMaterial").SealMaterial;

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** What a workspace's stored certificate is: self-signed, in its own name, and the configured identity. */
function workspaceCertificate(company: string): SealMaterial {
  const passphrase = "unit-test-passphrase";
  return { p12: selfSignedP12(`${company} document seal`, company, passphrase, 10), passphrase, source: "workspace", trusted: true };
}

async function blankPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function withoutServerCertificate<T>(run: () => Promise<T>): Promise<T> {
  delete process.env.BUILDER_SIGN_P12_BASE64;
  delete process.env.BUILDER_SIGN_P12_PASSPHRASE;
  return run();
}

test("a workspace certificate carries the company's name and lasts years, not until the next restart", () => {
  const info = sealCertificateInfo(workspaceCertificate("Société Müller & Søn (Pty) Ltd"));
  assert.match(info.subject, /Société Müller & Søn \(Pty\) Ltd document seal/, "a company name is not limited to ASCII");
  assert.match(info.subject, /O=Société Müller & Søn \(Pty\) Ltd/);
  assert.equal(info.subject, info.issuer, "self-signed: it vouches for itself and nobody is paid to");
  const years = (Date.parse(info.validTo) - Date.parse(info.validFrom)) / (365 * 86_400_000);
  assert.ok(years > 9.9 && years < 10.1, `valid for ${years.toFixed(2)} years`);
  assert.ok(Date.parse(info.validFrom) <= Date.now(), "already valid when it is made");
  assert.match(info.serialNumber, /^[0-7]/, "a serial with the high bit set is a negative number in DER");
  assert.equal(info.trusted, true);
  // Two certificates are never the same one.
  assert.notEqual(info.fingerprintSha256, sealCertificateInfo(workspaceCertificate("Société Müller & Søn (Pty) Ltd")).fingerprintSha256);
});

test("a document sealed with the workspace's certificate verifies, and is recognised as theirs", () =>
  withoutServerCertificate(async () => {
    const mine = workspaceCertificate("Acme Carts");
    const sealed = await sealPdf(await blankPdf(), { reason: "test", name: "Acme Carts" }, mine);

    const asMine = sealedPdfSignature(sealed, new Date(), sealCertificateInfo(mine));
    assert.ok(asMine);
    assert.equal(asMine.contentVerified, true, asMine.reason ?? "");
    assert.match(asMine.certificate.subject, /Acme Carts document seal/, "read out of the file, not out of configuration");
    assert.equal(asMine.certificate.fingerprintSha256, sealCertificateInfo(mine).fingerprintSha256);
    assert.equal(asMine.certificate.trusted, true, "it IS this workspace's configured identity");

    // The same file, checked against ANOTHER workspace's certificate — or none.
    const asSomeoneElse = sealedPdfSignature(sealed, new Date(), sealCertificateInfo(workspaceCertificate("Other Motors")));
    assert.equal(asSomeoneElse?.contentVerified, true, "the seal is still intact");
    assert.equal(asSomeoneElse?.certificate.trusted, false, "…but it is not theirs");
    assert.equal(sealedPdfSignature(sealed, new Date())?.certificate.trusted, false, "a self-signed certificate is in no trust store");
  }));

test("changing a sealed document is still caught", () =>
  withoutServerCertificate(async () => {
    const mine = workspaceCertificate("Acme Carts");
    const sealed = await sealPdf(await blankPdf(), { reason: "test", name: "Acme Carts" }, mine);
    const at = sealed.indexOf("/MediaBox");
    assert.ok(at > 0);
    const tampered = Buffer.from(sealed);
    tampered[at + 12] = tampered[at + 12] === 0x30 ? 0x31 : 0x30;
    const result = sealedPdfSignature(tampered, new Date(), sealCertificateInfo(mine));
    assert.equal(result?.contentVerified, false);
    assert.equal(result?.certificate.trusted, false, "an altered document is not vouched for, whoever sealed it");
  }));

test("a temporary certificate is never mistaken for the workspace's", () =>
  withoutServerCertificate(async () => {
    const temporary = temporarySealMaterial();
    assert.equal(temporary.source, "temporary");
    assert.equal(temporary.trusted, false);
    assert.equal(serverSealMaterial(), null);
    const info = sealCertificateInfo(temporary);
    assert.ok(info.subject.includes(TEMPORARY_SEAL_NAME));
    assert.doesNotMatch(info.subject, /Denago/, "it sealed every workspace's documents under one company's name");

    const sealed = await sealPdf(await blankPdf(), { reason: "test", name: "Anyone" });
    // Even handed to the verifier AS the configured identity, it does not qualify.
    assert.equal(sealedPdfSignature(sealed, new Date(), info)?.certificate.trusted, false);
    assert.equal(sealedPdfSignature(sealed, new Date(), info)?.contentVerified, true);
  }));

test("completion seals with the workspace's certificate, and the verifier is told whose it should be", () => {
  const complete = code("src/lib/signing/complete.ts");
  assert.match(complete, /await sealIdentityFor\(req\.tenantId\),\s*\);/, "the request's own workspace, named");
  const worker = code("src/lib/signing/jobWorker.ts");
  assert.match(worker, /const workspaceIdentity = await configuredSealIdentity\(job\.tenantId\);/);
  assert.match(worker, /workspaceIdentity \? sealCertificateInfo\(workspaceIdentity\) : null,/);
});

test("the stored certificate is a secret, made once, and a fallback is never silent", () => {
  const identity = code("src/lib/signing/sealIdentity.ts");
  assert.match(code("src/lib/settings.ts"), /"SIGNING_SEAL_IDENTITY",/, "encrypted at rest with every other credential");
  assert.match(identity, /value: encryptValue\(JSON\.stringify\(identity\)\)/, "never written in the clear");
  // First writer wins; everyone reads back the same row.
  assert.match(identity, /createMany\(\{\s*data: \[\{ tenantId, key: SEAL_IDENTITY_KEY,[^\]]*\}\],\s*skipDuplicates: true,\s*\}\)/);
  assert.ok(identity.indexOf("skipDuplicates: true") < identity.lastIndexOf("await readStored(tenantId)"), "read back after the write, not assumed");
  // The server's certificate still wins, strict mode still refuses anything else…
  const pick = identity.slice(identity.indexOf("export async function sealIdentityFor"));
  assert.ok(pick.indexOf("serverSealMaterial()") < pick.indexOf('signingSecurityMode() === "strict"'));
  assert.ok(pick.indexOf('signingSecurityMode() === "strict"') < pick.indexOf("ensureWorkspaceSealIdentity(tenantId)"));
  // …and the temporary certificate is only ever reached through an alert.
  assert.match(pick, /catch \(error\) \{\s*await logError\(\s*"signing-seal-fallback",/);
  // Viewing the settings page must not mint a certificate.
  const actions = code("src/app/actions/signingSecuritySettings.ts");
  const read = actions.slice(actions.indexOf("export async function readSealCertificate"), actions.indexOf("export async function createSealCertificate"));
  assert.match(read, /storedSealIdentity\(tenantId\)/);
  assert.doesNotMatch(read, /ensureWorkspaceSealIdentity/);
  assert.match(actions.slice(actions.indexOf("export async function createSealCertificate")), /await requireTenantOwner\(\)/);
});
