import crypto from "crypto";
import forge from "node-forge";

/**
 * The key material a PDF seal is made with, and the two kinds that need no
 * database: the operator's certificate from the environment, and the temporary
 * one made in memory when nothing better can be loaded.
 *
 * Kept apart from sealIdentity.ts — which stores and loads a workspace's own
 * certificate — so pdf/seal.ts can verify and seal without pulling the database
 * in behind it.
 */

export type SealSource =
  /** A PKCS#12 configured on the server, shared by every workspace. */
  | "server"
  /** This workspace's own certificate (sealIdentity.ts). */
  | "workspace"
  /** Made in memory for this process only. Never the intended seal on live. */
  | "temporary";

export type SealMaterial = {
  p12: Buffer;
  passphrase: string;
  source: SealSource;
  /** This is the identity the workspace is configured to seal with — the fingerprint route of trust. */
  trusted: boolean;
};

const TEMPORARY_PASSPHRASE = "denago-development-only";
/** What a temporary certificate calls itself — it used to read "Denago Development Seal" on every workspace's documents. */
export const TEMPORARY_SEAL_NAME = "Temporary seal (not a stored certificate)";

/** A self-signed signing certificate and its key, as a PKCS#12. */
export function selfSignedP12(commonName: string, organisation: string, passphrase: string, validYears = 1): Buffer {
  // Node's native generator: forge's pure-JS RSA holds the event loop for seconds.
  const pair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  // Positive by construction: a serial whose first byte has the high bit set is a
  // negative INTEGER in DER, which some validators refuse outright.
  cert.serialNumber = `01${crypto.randomBytes(15).toString("hex")}`;
  // Five minutes back. X.509 times are whole seconds, so a certificate made and
  // used in the same second could otherwise read as "not valid yet" at the very
  // instant it sealed its first document.
  cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + validYears);
  // UTF8String, because a company name is not limited to PrintableString's
  // alphabet. forge reads `valueTagClass` as the ASN.1 string TYPE for the value;
  // its typings declare the field as a tag class, hence the cast.
  const utf8 = forge.asn1.Type.UTF8;
  const name = [
    { name: "commonName", value: commonName, valueTagClass: utf8 },
    { name: "organizationName", value: organisation, valueTagClass: utf8 },
  ] as unknown as forge.pki.CertificateField[];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "subjectKeyIdentifier" },
  ]);
  const key = forge.pki.privateKeyFromPem(pair.privateKey);
  cert.sign(key, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(key, [cert], passphrase, { algorithm: "3des" });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
}

let temporary: Buffer | null = null;

/** One per process: nothing stores it, so a restart makes another. */
export function temporarySealMaterial(): SealMaterial {
  temporary ??= selfSignedP12(TEMPORARY_SEAL_NAME, "Temporary", TEMPORARY_PASSPHRASE);
  return { p12: temporary, passphrase: TEMPORARY_PASSPHRASE, source: "temporary", trusted: false };
}

/** The server-wide certificate, when the operator has configured one. */
export function serverSealMaterial(): SealMaterial | null {
  const b64 = process.env.BUILDER_SIGN_P12_BASE64;
  const pass = process.env.BUILDER_SIGN_P12_PASSPHRASE;
  return b64 && pass ? { p12: Buffer.from(b64, "base64"), passphrase: pass, source: "server", trusted: true } : null;
}
