import crypto from "crypto";
import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { assertSigningRuntimeReady, signingSecurityMode } from "@/lib/signing/securityPolicy";
import {
  attributesCoverContent,
  certificatesOf,
  digestAlgorithmOf,
  resolveSigner,
  signedAttributesOf,
  signedDataOf,
  signerInfoOf,
  verifyAttributeSignature,
} from "@/lib/signing/cms";
import { verifyCertificatePath } from "@/lib/signing/x509Path";
import { serverSealMaterial, temporarySealMaterial, type SealMaterial } from "@/lib/signing/sealMaterial";

/**
 * Applies a PKCS#7 digital seal to the completed PDF. Strict production mode
 * refuses to sign unless the private artifact store, tenant enforcement and a
 * configured PKCS#12 identity are all present.
 *
 * WHICH certificate seals is the caller's to say: completion passes the
 * workspace's own (signing/sealIdentity.ts). With none passed, this falls back
 * to the server's certificate, and — outside strict mode — to a temporary one
 * made in memory. That last fallback is for a laptop and a test run; it sealed a
 * customer's contract on live, unnoticed, when the environment certificate went
 * missing, which is why completion no longer relies on it.
 */

/** The certificate available without a database: the server's, else a temporary one. */
function getSigner(): SealMaterial {
  const server = serverSealMaterial();
  if (server) return server;
  if (signingSecurityMode() === "strict") {
    // assertSigningRuntimeReady gives the operator the full configuration list.
    assertSigningRuntimeReady("PDF sealing");
    throw new Error("Trusted PDF signing identity is unavailable");
  }
  return temporarySealMaterial();
}

function certificateFrom(material: SealMaterial): forge.pki.Certificate {
  const asn1 = forge.asn1.fromDer(material.p12.toString("binary"));
  const store = forge.pkcs12.pkcs12FromAsn1(asn1, material.passphrase);
  const bags = store.getBags({ bagType: forge.pki.oids.certBag });
  const cert = bags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!cert) throw new Error("The PKCS#12 signing identity contains no certificate");
  return cert;
}

/**
 * A certificate's subject or issuer as a person reads it: "CN=…, O=…".
 *
 * forge hands back a UTF8String attribute as its raw BYTES — one character per
 * byte — so a name with anything outside ASCII read as "SociÃ©tÃ©". Modern
 * certificates use UTF8String for every name, so that was any certificate whose
 * holder is not spelled in plain English letters. The string type is on the
 * attribute; decode when it says UTF-8, and leave a value alone when its bytes
 * turn out not to be.
 */
function distinguishedName(attrs: forge.pki.CertificateField[]): string {
  return attrs
    .map((attr) => {
      let value = String(attr.value ?? "");
      if ((attr.valueTagClass as unknown) === forge.asn1.Type.UTF8) {
        try {
          value = forge.util.decodeUtf8(value);
        } catch {
          // Not valid UTF-8 after all: show what is there rather than nothing.
        }
      }
      return `${attr.shortName || attr.name}=${value}`;
    })
    .join(", ");
}

export type SigningCertificateInfo = {
  fingerprintSha256: string;
  subject: string;
  issuer: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
  trusted: boolean;
};

export function configuredSigningCertificateInfo(): SigningCertificateInfo {
  return sealCertificateInfo(getSigner());
}

/** Who a given certificate is, read out of its PKCS#12. */
export function sealCertificateInfo(material: SealMaterial): SigningCertificateInfo {
  const cert = certificateFrom(material);
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary");
  return {
    fingerprintSha256: crypto.createHash("sha256").update(der).digest("hex"),
    subject: distinguishedName(cert.subject.attributes),
    issuer: distinguishedName(cert.issuer.attributes),
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    trusted: material.trusted,
  };
}

/**
 * Refuse to seal with a certificate that is not valid RIGHT NOW.
 *
 * `assertSigningRuntimeReady` checks that a PKCS#12 identity is configured; it
 * never asked whether that identity is still in date. An expired key signs bytes
 * exactly as well as a current one, so nothing fails at signing time — the
 * document is produced, filed, and only reports as untrusted later, when the
 * validator asks the question that was never asked here. By then the signature
 * is on a contract.
 *
 * Future-dated is refused for the same reason, in the other direction.
 */
function assertConfiguredCertificateInDate(): void {
  const cert = certificateFrom(getSigner());
  const now = new Date();
  if (now < cert.validity.notBefore) {
    throw new Error(
      `The configured signing certificate is not valid until ${cert.validity.notBefore.toISOString()}`,
    );
  }
  if (now > cert.validity.notAfter) {
    throw new Error(
      `The configured signing certificate expired on ${cert.validity.notAfter.toISOString()}`,
    );
  }
}

export async function sealPdf(
  pdfBuffer: Buffer,
  meta: { reason: string; name: string; location?: string; contactInfo?: string },
  /** The certificate to seal with — the workspace's own. Omitted: the server's, else a temporary one. */
  material?: SealMaterial,
): Promise<Buffer> {
  if (signingSecurityMode() === "strict") {
    assertSigningRuntimeReady("PDF sealing");
    assertConfiguredCertificateInDate();
  }
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer,
    reason: meta.reason,
    contactInfo: meta.contactInfo ?? "",
    name: meta.name,
    location: meta.location ?? "",
  });
  const { p12, passphrase } = material ?? getSigner();
  const signer = new P12Signer(p12, { passphrase });
  return new SignPdf().sign(withPlaceholder, signer);
}


export type SealedPdfSignature = {
  /** Whose certificate sealed the file — read from the file, never from config. */
  certificate: SigningCertificateInfo;
  /** The PKCS#7 signature verifies over the byte ranges the PDF itself declares. */
  contentVerified: boolean;
  /** Why not, when something failed. Null when everything checked out. */
  reason: string | null;
};

type SealParts = { der: Buffer; signedBytes: Buffer; wholeFile: boolean; gapExact: boolean };

/**
 * Locate a signed PDF's ByteRange and the PKCS#7 blob sitting in its gap.
 *
 * ── Why the gap is checked EXACTLY ──────────────────────────────────────────
 *
 * Every byte between the two covered ranges is, by definition, unsigned. The
 * ByteRange numbers themselves sit inside the first covered range, so an
 * attacker cannot move the gap — but they can rewrite anything INSIDE it and
 * the signature still verifies.
 *
 * The gap is roughly 16 KB of placeholder. An earlier version of this function
 * only asked that a `/Contents <…>` appear SOMEWHERE within it, which accepts:
 *
 *     <  …real DER hex…  >  …arbitrary injected PDF content…  …padding…
 *
 * The signature checks out, the certificate is genuine, and several kilobytes of
 * content nobody signed ride along inside the hole. For a legal artifact that is
 * the whole ballgame.
 *
 * So the container must occupy the gap precisely: `<` as the first excluded
 * byte, `>` as the last, and nothing but hex and whitespace in between.
 */
function sealParts(pdf: Buffer): SealParts | null {
  const text = pdf.toString("latin1");
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!range) return null;
  const [a, b, c, d] = range.slice(1, 5).map(Number);
  if ([a, b, c, d].some((n) => !Number.isFinite(n) || n < 0) || a + b > c || c + d > pdf.length) return null;

  const signedBytes = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  // Anything outside the two ranges was added AFTER signing and is not covered
  // by it. For a legal artifact that is a defect, not a detail.
  const wholeFile = a === 0 && c + d === pdf.length;

  // The gap starts at the `<`, not at the `/Contents` key — the key itself is
  // inside the FIRST covered range. Anchoring on the key skips the real
  // signature and finds nothing, which reads identically to "unsigned file".
  const gap = text.slice(a + b, c);
  const exact = /^<([0-9a-fA-F\s]*)>$/.exec(gap);
  if (exact) {
    const hex = exact[1].replace(/\s/g, "");
    if (hex.length >= 64) {
      return { der: Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, "hex"), signedBytes, wholeFile, gapExact: true };
    }
  }

  // The gap is NOT just a signature container. Still recover the certificate, so
  // the failure is reported as a tampered seal naming who signed it rather than
  // as "this file is not signed" — those are very different findings.
  const loose = /<([0-9a-fA-F\s]{64,})>/.exec(gap);
  if (!loose) return null;
  const hex = loose[1].replace(/\s/g, "");
  return {
    der: Buffer.from(hex.length % 2 ? hex.slice(0, -1) : hex, "hex"),
    signedBytes,
    wholeFile,
    gapExact: false,
  };
}

/**
 * The certificate that ACTUALLY sealed a PDF, and whether it really did.
 *
 * Two separate questions, and the previous version answered neither honestly.
 * It recorded `configuredSigningCertificateInfo()` — the identity configured
 * right now — as evidence about a document sealed possibly years earlier, which
 * after a rotation describes a certificate that never touched the file. Then the
 * fix for that returned `trusted: false` unconditionally, which in strict mode
 * failed every artifact and retried it to a dead letter: a validator that
 * refuses everything is no better than one that believes everything.
 *
 * So metadata extraction and trust are separated. This function reads WHO
 * sealed it and checks THAT THEY DID — the PKCS#7 signature is verified over the
 * exact bytes the PDF's own ByteRange declares. Whether that signer is trusted
 * is a further question, answered by `sealedPdfTrust` against a real
 * certification path.
 *
 * Returns null when the file carries no recognisable signature, which the caller
 * records as an error rather than silently substituting today's configuration.
 */
export function sealedPdfSignature(
  pdf: Buffer,
  at: Date,
  /**
   * The identity this document's WORKSPACE is configured to seal with
   * (sealIdentity.ts → configuredSealIdentity), for the fingerprint route of
   * trust. Omitted, the server's own certificate is compared instead.
   */
  configured?: SigningCertificateInfo | null,
): SealedPdfSignature | null {
  let parts: ReturnType<typeof sealParts>;
  try {
    parts = sealParts(pdf);
  } catch {
    return null;
  }
  if (!parts) return null;

  const signedData = signedDataOf(parts.der);
  if (!signedData) return null;
  const certs = certificatesOf(signedData);
  const signerInfo = signerInfoOf(signedData);
  if (certs.length === 0 || !signerInfo) return null;

  // The signer NAMED by SignerInfo. `certificates[0]` is a guess, and a PDF may
  // carry intermediates alongside the signer.
  const signer = resolveSigner(signerInfo, certs);
  if (!signer) return null;

  const certificate: SigningCertificateInfo = {
    fingerprintSha256: crypto.createHash("sha256").update(signer.der).digest("hex"),
    subject: distinguishedName(signer.parsed.subject.attributes),
    issuer: distinguishedName(signer.parsed.issuer.attributes),
    serialNumber: signer.parsed.serialNumber,
    validFrom: signer.parsed.validity.notBefore.toISOString(),
    validTo: signer.parsed.validity.notAfter.toISOString(),
    // Set below. Extraction never asserts trust it has not established.
    trusted: false,
  };

  const digestName = digestAlgorithmOf(signerInfo);
  const attrs = signedAttributesOf(signerInfo);
  if (!attrs) return { certificate, contentVerified: false, reason: "the seal carries no signed attributes" };

  const contentDigest = crypto.createHash(digestName).update(parts.signedBytes).digest();
  if (!attributesCoverContent(attrs.node, contentDigest)) {
    // THE ASSERTION THAT WAS MISSING. A stored hash proves the blob has not
    // changed since we filed it; it says nothing about whether this certificate
    // ever sealed these bytes.
    return { certificate, contentVerified: false, reason: "the seal does not cover this document's bytes" };
  }
  if (!verifyAttributeSignature(attrs, signer.parsed, digestName)) {
    return { certificate, contentVerified: false, reason: "the seal's signature does not verify" };
  }
  if (!parts.wholeFile) {
    return { certificate, contentVerified: false, reason: "content was appended after the document was sealed" };
  }
  if (!parts.gapExact) {
    // The signature verified — over the bytes it covers. The unsigned gap holds
    // more than the signature value, and those bytes are part of the document a
    // reader will render.
    return {
      certificate,
      contentVerified: false,
      reason: "the unsigned gap contains more than the signature value",
    };
  }

  // `at` is the instant the document was actually sealed. Asking the certificate
  // whether it was valid at its own notBefore is a question that answers itself.
  const trust = sealedPdfTrust(signer.der, certs.map((candidate) => candidate.der), at, configured);
  return {
    certificate: { ...certificate, trusted: trust.trusted },
    contentVerified: true,
    reason: trust.trusted ? null : trust.reason,
  };
}

/**
 * Is the signer of a sealed PDF an identity this system should believe?
 *
 * Two ways to qualify, and both are needed:
 *
 *   - a certification path to a root in the trust store, which is what makes a
 *     purchased certificate verifiable by anyone, not just by us; or
 *   - an exact fingerprint match with the configured signing identity, which is
 *     how an internal CA or a self-signed production identity qualifies without
 *     asking the operator to install roots.
 *
 * The fingerprint route deliberately does NOT survive a certificate rotation for
 * a self-signed identity: after rotating, historic documents sealed with the old
 * key stop matching and are reported untrusted. That is honest — nothing in the
 * system can vouch for them any more — and it is why a certificate that chains
 * to a public root is the better choice for anything that must outlive its key.
 */
function sealedPdfTrust(
  signerDer: Buffer,
  poolDer: Buffer[],
  at: Date,
  workspaceIdentity?: SigningCertificateInfo | null,
): { trusted: boolean; reason: string | null } {
  const path = verifyCertificatePath({ leafDer: signerDer, poolDer, at });
  if (path.ok) return { trusted: true, reason: null };

  try {
    // The workspace's own certificate when the caller knows it; the server's
    // otherwise. A temporary certificate is never "the configured identity" —
    // its `trusted` is false, so the comparison below cannot pass for it.
    const configured = workspaceIdentity ?? configuredSigningCertificateInfo();
    const fingerprint = crypto.createHash("sha256").update(signerDer).digest("hex");
    if (configured.trusted && configured.fingerprintSha256 === fingerprint) {
      // BEING the configured identity is not a licence to be out of date. An
      // expired key signs bytes exactly as well as a current one, so without
      // this the fingerprint route would wave through a document sealed years
      // after the certificate lapsed — the precise case the validation instant
      // exists to catch.
      const from = new Date(configured.validFrom);
      const to = new Date(configured.validTo);
      if (at >= from && at <= to) return { trusted: true, reason: null };
      return {
        trusted: false,
        reason: "the configured signing certificate was not valid when this document was sealed",
      };
    }
  } catch {
    // No configured identity to compare against; the path result stands.
  }
  return { trusted: false, reason: path.reason };
}
