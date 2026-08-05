import crypto from "crypto";
import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { assertSigningRuntimeReady, signingSecurityMode } from "@/lib/signing/securityPolicy";

/**
 * Applies a PKCS#7 digital seal to the completed PDF. Strict production mode
 * refuses to sign unless the private artifact store, tenant enforcement and a
 * configured PKCS#12 identity are all present. A process-generated self-signed
 * identity is retained only for local/test compatibility and can never silently
 * become the production trust anchor.
 */

const DEVELOPMENT_PASSPHRASE = "denago-development-only";

type SignerMaterial = { p12: Buffer; passphrase: string; trusted: boolean };

function getSigner(): SignerMaterial {
  const b64 = process.env.BUILDER_SIGN_P12_BASE64;
  const pass = process.env.BUILDER_SIGN_P12_PASSPHRASE;
  if (b64 && pass) return { p12: Buffer.from(b64, "base64"), passphrase: pass, trusted: true };
  if (signingSecurityMode() === "strict") {
    // assertSigningRuntimeReady gives the operator the full configuration list.
    assertSigningRuntimeReady("PDF sealing");
    throw new Error("Trusted PDF signing identity is unavailable");
  }
  return { p12: makeDevelopmentP12(), passphrase: DEVELOPMENT_PASSPHRASE, trusted: false };
}

let developmentCache: Buffer | null = null;

function makeDevelopmentP12(): Buffer {
  if (developmentCache) return developmentCache;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [
    { name: "commonName", value: "Denago Development Seal" },
    { name: "organizationName", value: "Denago Cape Town" },
    { name: "countryName", value: "ZA" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], DEVELOPMENT_PASSPHRASE, { algorithm: "3des" });
  developmentCache = Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
  return developmentCache;
}

function certificateFrom(material: SignerMaterial): forge.pki.Certificate {
  const asn1 = forge.asn1.fromDer(material.p12.toString("binary"));
  const store = forge.pkcs12.pkcs12FromAsn1(asn1, material.passphrase);
  const bags = store.getBags({ bagType: forge.pki.oids.certBag });
  const cert = bags[forge.pki.oids.certBag]?.[0]?.cert;
  if (!cert) throw new Error("The PKCS#12 signing identity contains no certificate");
  return cert;
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
  const material = getSigner();
  const cert = certificateFrom(material);
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary");
  const name = (attrs: forge.pki.CertificateField[]) =>
    attrs.map((attr) => `${attr.shortName || attr.name}=${attr.value}`).join(", ");
  return {
    fingerprintSha256: crypto.createHash("sha256").update(der).digest("hex"),
    subject: name(cert.subject.attributes),
    issuer: name(cert.issuer.attributes),
    serialNumber: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    trusted: material.trusted,
  };
}

export async function sealPdf(
  pdfBuffer: Buffer,
  meta: { reason: string; name: string; location?: string; contactInfo?: string }
): Promise<Buffer> {
  if (signingSecurityMode() === "strict") assertSigningRuntimeReady("PDF sealing");
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer,
    reason: meta.reason,
    contactInfo: meta.contactInfo ?? "sales@denagocpt.co.za",
    name: meta.name,
    location: meta.location ?? "Cape Town, ZA",
  });
  const { p12, passphrase } = getSigner();
  const signer = new P12Signer(p12, { passphrase });
  return new SignPdf().sign(withPlaceholder, signer);
}
