import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";

/**
 * SPIKE — applies a real PKCS#7 digital seal to a PDF so any reader (Adobe etc.)
 * can detect tampering: change one byte after sealing and the signature reports
 * invalid. This is the OpenSign lesson made in-house.
 *
 * The certificate here is self-signed and generated per request purely to prove
 * the mechanism. In production it becomes a single persistent P12 held as a
 * secret (or a CA-issued cert), so signatures chain to a trusted identity.
 */

const PASSPHRASE = "denago-spike";

function makeSelfSignedP12(): Buffer {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
  const attrs = [
    { name: "commonName", value: "Denago Cape Town" },
    { name: "organizationName", value: "Denago Cape Town" },
    { name: "countryName", value: "ZA" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSPHRASE, { algorithm: "3des" });
  const der = forge.asn1.toDer(asn1).getBytes();
  return Buffer.from(der, "binary");
}

export async function sealPdf(
  pdfBuffer: Buffer,
  meta: { reason: string; name: string; location?: string; contactInfo?: string }
): Promise<Buffer> {
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer,
    reason: meta.reason,
    contactInfo: meta.contactInfo ?? "sales@denagocpt.co.za",
    name: meta.name,
    location: meta.location ?? "Cape Town, ZA",
  });
  const signer = new P12Signer(makeSelfSignedP12(), { passphrase: PASSPHRASE });
  return new SignPdf().sign(withPlaceholder, signer);
}
