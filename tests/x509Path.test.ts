import test from "node:test";
import assert from "node:assert/strict";
import forge from "node-forge";

import { verifyCertificatePath, resetTrustedRootCache } from "../src/lib/signing/x509Path";

/**
 * The certification path validator, tested where it actually mattered.
 *
 * The previous implementation checked only `checkIssued()` and `verify()` at
 * each link. Both can be true for a certificate that was never authorised to
 * issue certificates at all — `checkIssued()` is a NAME comparison, and any
 * private key can mathematically sign a certificate. So an ordinary end-entity
 * certificate could be placed in an intermediate position and be believed.
 *
 * These tests build that exact attack out of real certificates and require it to
 * be refused, and they build the legitimate shapes and require those to pass —
 * because a validator that rejects everything is just as broken, and that is the
 * failure mode this code has already produced twice.
 */

// Distinct keys per certificate ON PURPOSE. Reusing one key would make every
// signature verify under every other certificate, and the negative tests below
// would pass without testing anything.
const keys = Array.from({ length: 5 }, () => forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 }));

const YEAR = 365 * 24 * 60 * 60 * 1000;
const AT = new Date("2025-06-01T00:00:00Z");

// node-forge's typings do not name the extension shape; `setExtensions` takes
// plain objects.
type CertExtension = Record<string, unknown>;

type CertOptions = {
  name: string;
  keyIndex: number;
  issuer?: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey; name: string };
  extensions?: CertExtension[];
  notBefore?: Date;
  notAfter?: Date;
};

let serial = 1;

function makeCert(options: CertOptions): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys[options.keyIndex].publicKey;
  cert.serialNumber = String(serial++).padStart(4, "0");
  cert.validity.notBefore = options.notBefore ?? new Date(AT.getTime() - YEAR);
  cert.validity.notAfter = options.notAfter ?? new Date(AT.getTime() + YEAR);
  cert.setSubject([{ name: "commonName", value: options.name }]);
  cert.setIssuer([{ name: "commonName", value: options.issuer?.name ?? options.name }]);
  if (options.extensions) cert.setExtensions(options.extensions);
  cert.sign(options.issuer?.key ?? keys[options.keyIndex].privateKey, forge.md.sha256.create());
  return cert;
}

const CA_EXT = (pathLen?: number): CertExtension[] => [
  pathLen === undefined
    ? { name: "basicConstraints", cA: true, critical: true }
    : { name: "basicConstraints", cA: true, pathLenConstraint: pathLen, critical: true },
  { name: "keyUsage", keyCertSign: true, digitalSignature: true, critical: true },
];

const LEAF_EXT: CertExtension[] = [
  { name: "basicConstraints", cA: false, critical: true },
  { name: "keyUsage", keyCertSign: false, digitalSignature: true, critical: true },
];

// cA=false and NO KeyUsage extension at all — the shape OpenSSL's
// X509_check_issued does NOT reject, because it only refuses an issuer whose
// KeyUsage is present and withholds keyCertSign. Anything that leans on
// checkIssued() alone accepts this certificate as an intermediate.
const BARE_LEAF_EXT: CertExtension[] = [
  { name: "basicConstraints", cA: false, critical: true },
];

const der = (cert: forge.pki.Certificate): Buffer =>
  Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary");
const pem = (cert: forge.pki.Certificate): string => forge.pki.certificateToPem(cert);

// A root we control, injected through the documented operator setting.
const root = makeCert({ name: "Test Root CA", keyIndex: 0, extensions: CA_EXT() });

function withRoot(run: () => void): void {
  const previous = process.env.SIGNING_TSA_ROOTS_PEM;
  process.env.SIGNING_TSA_ROOTS_PEM = pem(root);
  resetTrustedRootCache();
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.SIGNING_TSA_ROOTS_PEM;
    else process.env.SIGNING_TSA_ROOTS_PEM = previous;
    resetTrustedRootCache();
  }
}

const rootIssuer = { cert: root, key: keys[0].privateKey, name: "Test Root CA" };

test("a genuine path to a trusted root validates", () => {
  const leaf = makeCert({ name: "Signer", keyIndex: 1, issuer: rootIssuer, extensions: LEAF_EXT });
  withRoot(() => {
    const result = verifyCertificatePath({ leafDer: der(leaf), poolDer: [der(root)], at: AT });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
  });
});

test("an end-entity certificate cannot act as an intermediate", () => {
  // THE ATTACK, in the shape that actually gets through. `middle` is a valid
  // certificate issued by the trusted root, was never authorised to issue
  // certificates, and carries no KeyUsage extension — so OpenSSL's
  // X509_check_issued permits it as an issuer and only the explicit
  // basicConstraints check refuses it. Its key signs `leaf` perfectly well.
  const middle = makeCert({ name: "Ordinary Leaf", keyIndex: 1, issuer: rootIssuer, extensions: BARE_LEAF_EXT });
  const leaf = makeCert({
    name: "Forged Signer",
    keyIndex: 2,
    issuer: { cert: middle, key: keys[1].privateKey, name: "Ordinary Leaf" },
    extensions: LEAF_EXT,
  });

  withRoot(() => {
    const result = verifyCertificatePath({
      leafDer: der(leaf),
      poolDer: [der(middle), der(root)],
      at: AT,
    });
    assert.equal(result.ok, false, "an end-entity certificate must not be usable as a CA");
    assert.match((result as { reason: string }).reason, /not a certificate authority/);
  });
});

test("a CA whose KeyUsage withholds keyCertSign is refused", () => {
  // basicConstraints says CA, KeyUsage says "not for signing certificates".
  // RFC 5280 §4.2.1.3 makes the refusal binding; believing basicConstraints
  // alone would accept it.
  const contradictory = makeCert({
    name: "Contradictory CA",
    keyIndex: 1,
    issuer: rootIssuer,
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: false, digitalSignature: true, critical: true },
    ],
  });
  const leaf = makeCert({
    name: "Signer",
    keyIndex: 2,
    issuer: { cert: contradictory, key: keys[1].privateKey, name: "Contradictory CA" },
    extensions: LEAF_EXT,
  });

  withRoot(() => {
    const result = verifyCertificatePath({
      leafDer: der(leaf),
      poolDer: [der(contradictory), der(root)],
      at: AT,
    });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /withholds keyCertSign/);
  });
});

test("pathLenConstraint is enforced", () => {
  // upper permits ZERO intermediates below it, so upper → lower → leaf is one
  // level too deep and must be refused.
  const upper = makeCert({ name: "Upper CA", keyIndex: 1, issuer: rootIssuer, extensions: CA_EXT(0) });
  const lower = makeCert({
    name: "Lower CA",
    keyIndex: 2,
    issuer: { cert: upper, key: keys[1].privateKey, name: "Upper CA" },
    extensions: CA_EXT(),
  });
  const leaf = makeCert({
    name: "Signer",
    keyIndex: 3,
    issuer: { cert: lower, key: keys[2].privateKey, name: "Lower CA" },
    extensions: LEAF_EXT,
  });

  withRoot(() => {
    const result = verifyCertificatePath({
      leafDer: der(leaf),
      poolDer: [der(lower), der(upper), der(root)],
      at: AT,
    });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /permits only 0 intermediate/);
  });
});

test("the path is BUILT, not read in the order the message listed", () => {
  // CMS does not promise an order and may carry unrelated certificates. A
  // validator that walks the array positionally fails on a legitimate token.
  const intermediate = makeCert({ name: "Real CA", keyIndex: 1, issuer: rootIssuer, extensions: CA_EXT() });
  const unrelated = makeCert({ name: "Unrelated", keyIndex: 4, issuer: rootIssuer, extensions: LEAF_EXT });
  const leaf = makeCert({
    name: "Signer",
    keyIndex: 2,
    issuer: { cert: intermediate, key: keys[1].privateKey, name: "Real CA" },
    extensions: LEAF_EXT,
  });

  withRoot(() => {
    const result = verifyCertificatePath({
      leafDer: der(leaf),
      // Deliberately shuffled, with a decoy first.
      poolDer: [der(unrelated), der(root), der(intermediate)],
      at: AT,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
  });
});

test("a certificate that had expired at the attested time is refused", () => {
  // The question is not "is it valid now" but "was it valid when it attested".
  const expired = makeCert({
    name: "Expired CA",
    keyIndex: 1,
    issuer: rootIssuer,
    extensions: CA_EXT(),
    notBefore: new Date(AT.getTime() - 3 * YEAR),
    notAfter: new Date(AT.getTime() - 2 * YEAR),
  });
  const leaf = makeCert({
    name: "Signer",
    keyIndex: 2,
    issuer: { cert: expired, key: keys[1].privateKey, name: "Expired CA" },
    extensions: LEAF_EXT,
  });

  withRoot(() => {
    const result = verifyCertificatePath({
      leafDer: der(leaf),
      poolDer: [der(expired), der(root)],
      at: AT,
    });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /not valid at the attested time/);
  });
});

test("a token cannot supply its own trust anchor", () => {
  // A self-signed CA that is simply not in the store. Accepting it would make
  // the whole exercise circular: anyone can mint a root.
  const rogueKeys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const rogue = forge.pki.createCertificate();
  rogue.publicKey = rogueKeys.publicKey;
  rogue.serialNumber = "9999";
  rogue.validity.notBefore = new Date(AT.getTime() - YEAR);
  rogue.validity.notAfter = new Date(AT.getTime() + YEAR);
  rogue.setSubject([{ name: "commonName", value: "Rogue Root" }]);
  rogue.setIssuer([{ name: "commonName", value: "Rogue Root" }]);
  rogue.setExtensions(CA_EXT());
  rogue.sign(rogueKeys.privateKey, forge.md.sha256.create());

  const leaf = makeCert({
    name: "Signer",
    keyIndex: 2,
    issuer: { cert: rogue, key: rogueKeys.privateKey, name: "Rogue Root" },
    extensions: LEAF_EXT,
  });

  withRoot(() => {
    const result = verifyCertificatePath({
      leafDer: der(leaf),
      poolDer: [der(rogue)],
      at: AT,
    });
    assert.equal(result.ok, false);
    assert.match((result as { reason: string }).reason, /no certification path to a trusted root/);
  });
});
