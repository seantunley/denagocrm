import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";

/**
 * SPIKE — applies a real PKCS#7 digital seal to a PDF so any reader (Adobe etc.)
 * can detect tampering: change one byte after sealing and the signature reports
 * invalid. This is the OpenSign lesson made in-house.
 *
 * The signing identity comes from getSigner(): the configured P12 secret in
 * production (BUILDER_SIGN_P12_BASE64/_PASSPHRASE) so signatures chain to a
 * trusted identity, or a cached self-signed cert otherwise (mechanism still
 * tamper-evident, validity "unknown"). Not generated per request.
 */

const PASSPHRASE = "denago-spike";

/**
 * The signing identity. Production: set BUILDER_SIGN_P12_BASE64 (a base64 PKCS#12)
 * and BUILDER_SIGN_P12_PASSPHRASE as secrets → signatures chain to a real,
 * trusted identity (Adobe shows a valid signature). Otherwise a self-signed cert
 * is generated so the tamper-evident mechanism still works (validity "unknown").
 */
function getSigner(): { p12: Buffer; passphrase: string } {
  const b64 = process.env.BUILDER_SIGN_P12_BASE64;
  const pass = process.env.BUILDER_SIGN_P12_PASSPHRASE;
  if (b64 && pass) return { p12: Buffer.from(b64, "base64"), passphrase: pass };
  return { p12: makeSelfSignedP12(), passphrase: PASSPHRASE };
}

let selfSignedCache: Buffer | null = null;

function makeSelfSignedP12(): Buffer {
  if (selfSignedCache) return selfSignedCache;
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
  selfSignedCache = Buffer.from(der, "binary");
  return selfSignedCache;
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
  const { p12, passphrase } = getSigner();
  const signer = new P12Signer(p12, { passphrase });
  return new SignPdf().sign(withPlaceholder, signer);
}
