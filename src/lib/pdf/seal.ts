import crypto from "crypto";
import forge from "node-forge";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { plainAddPlaceholder } from "@signpdf/placeholder-plain";
import { isProductionRuntime } from "@/lib/signing/securityConfig";

export type SealMetadata = { reason: string; name: string; location?: string; contactInfo?: string };
export type SealEvidence = {
  pdf: Buffer;
  certificateFingerprint: string;
  certificateChain: string[];
  keyId: string | null;
  trustPolicy: string;
  timestampToken: Buffer | null;
  validationReport: { valid: boolean; profile: string; checkedAt: string; details?: unknown };
};

type TrustServiceResponse = {
  sealedPdfBase64: string;
  certificateFingerprint: string;
  certificateChainPem: string[];
  keyId?: string;
  trustPolicy: string;
  timestampTokenBase64?: string;
  validationReport: { valid: boolean; profile: string; checkedAt?: string; details?: unknown };
};

async function sealWithTrustService(pdf: Buffer, meta: SealMetadata): Promise<SealEvidence> {
  const url = process.env.SIGNING_TRUST_SERVICE_URL;
  const token = process.env.SIGNING_TRUST_SERVICE_TOKEN;
  if (!url || !token) throw new Error("Signing trust service is not configured");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      pdfBase64: pdf.toString("base64"),
      metadata: meta,
      requestedProfile: process.env.SIGNING_PADES_PROFILE || "PAdES-B-LT",
      requireTrustedTimestamp: true,
      requireIndependentValidation: true,
    }),
    signal: AbortSignal.timeout(Number(process.env.SIGNING_TRUST_SERVICE_TIMEOUT_MS || 45_000)),
  });
  if (!response.ok) throw new Error(`Trust service failed: ${response.status} ${await response.text()}`);
  const result = (await response.json()) as TrustServiceResponse;
  if (!result.sealedPdfBase64 || !result.certificateFingerprint || !result.validationReport?.valid) {
    throw new Error("Trust service returned an incomplete or invalid signing result");
  }
  if (!result.timestampTokenBase64) throw new Error("Trust service omitted the required RFC 3161 timestamp token");
  const sealed = Buffer.from(result.sealedPdfBase64, "base64");
  if (!sealed.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Trust service returned a non-PDF artifact");
  return {
    pdf: sealed,
    certificateFingerprint: result.certificateFingerprint.toLowerCase().replace(/:/g, ""),
    certificateChain: result.certificateChainPem || [],
    keyId: result.keyId || null,
    trustPolicy: result.trustPolicy || "PAdES-B-LT",
    timestampToken: Buffer.from(result.timestampTokenBase64, "base64"),
    validationReport: {
      ...result.validationReport,
      checkedAt: result.validationReport.checkedAt || new Date().toISOString(),
    },
  };
}

const DEV_PASSPHRASE = "denago-development-only";
let selfSignedCache: Buffer | null = null;
function makeDevelopmentP12(): Buffer {
  if (selfSignedCache) return selfSignedCache;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString("hex");
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [
    { name: "commonName", value: "Denago Development Seal" },
    { name: "organizationName", value: "Denago Cape Town" },
    { name: "countryName", value: "ZA" },
  ];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  selfSignedCache = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], DEV_PASSPHRASE, { algorithm: "3des" })).getBytes(), "binary");
  return selfSignedCache;
}

function localSigner(): { p12: Buffer; passphrase: string; dev: boolean } {
  const p12 = process.env.BUILDER_SIGN_P12_BASE64;
  const passphrase = process.env.BUILDER_SIGN_P12_PASSPHRASE;
  if (p12 && passphrase) return { p12: Buffer.from(p12, "base64"), passphrase, dev: false };
  if (isProductionRuntime()) throw new Error("Production sealing fails closed without the configured trust service");
  return { p12: makeDevelopmentP12(), passphrase: DEV_PASSPHRASE, dev: true };
}

function p12Evidence(p12: Buffer, passphrase: string): { fingerprint: string; chain: string[] } {
  const asn1 = forge.asn1.fromDer(p12.toString("binary"));
  const store = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
  const bags = store.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const chain = bags.flatMap((bag) => bag.cert ? [forge.pki.certificateToPem(bag.cert)] : []);
  if (!bags[0]?.cert) throw new Error("PKCS#12 contains no certificate");
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(bags[0].cert)).getBytes(), "binary");
  return { fingerprint: crypto.createHash("sha256").update(der).digest("hex"), chain };
}

async function sealLocally(pdf: Buffer, meta: SealMetadata): Promise<SealEvidence> {
  const identity = localSigner();
  const withPlaceholder = plainAddPlaceholder({
    pdfBuffer: pdf,
    reason: meta.reason,
    contactInfo: meta.contactInfo ?? "sales@denagocpt.co.za",
    name: meta.name,
    location: meta.location ?? "Cape Town, ZA",
  });
  const sealed = await new SignPdf().sign(withPlaceholder, new P12Signer(identity.p12, { passphrase: identity.passphrase }));
  const certificate = p12Evidence(identity.p12, identity.passphrase);
  return {
    pdf: sealed,
    certificateFingerprint: certificate.fingerprint,
    certificateChain: certificate.chain,
    keyId: null,
    trustPolicy: identity.dev ? "development-self-signed" : "local-pkcs12-no-timestamp",
    timestampToken: null,
    validationReport: {
      valid: true,
      profile: identity.dev ? "PKCS7-development" : "PKCS7-local",
      checkedAt: new Date().toISOString(),
      details: { sha256: crypto.createHash("sha256").update(sealed).digest("hex"), independentlyValidated: false },
    },
  };
}

export async function sealPdfWithEvidence(pdf: Buffer, meta: SealMetadata): Promise<SealEvidence> {
  if (process.env.SIGNING_TRUST_SERVICE_URL) return sealWithTrustService(pdf, meta);
  return sealLocally(pdf, meta);
}

/** Compatibility wrapper for callers that only need the sealed bytes. */
export async function sealPdf(pdf: Buffer, meta: SealMetadata): Promise<Buffer> {
  return (await sealPdfWithEvidence(pdf, meta)).pdf;
}
