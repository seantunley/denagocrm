import crypto from "crypto";
import forge from "node-forge";
import {
  Asn1,
  attributesCoverContent,
  certificatesOf,
  children,
  digestAlgorithmOf,
  resolveSigner,
  signedAttributesOf,
  signedDataOf,
  signerInfoOf,
  verifyAttributeSignature,
} from "./cms";
import { verifyCertificatePath } from "./x509Path";

/**
 * Cryptographic validation of an RFC 3161 timestamp token.
 *
 * Without this, a stored token proves nothing: the system asked an authority for
 * an attestation, kept whatever came back, and checked only that the document's
 * digest appeared in it. Over plain HTTP — which is what public authorities
 * serve — anyone on the path could have supplied a plausible reply.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 *
 *   1. the encapsulated TSTInfo's message imprint IS this document's digest;
 *   2. the SIGNER is resolved from SignerInfo — not assumed to be the first
 *      certificate the token happens to carry;
 *   3. the signed attributes carry a messageDigest over that TSTInfo;
 *   4. the signature over those attributes verifies under the signer's key;
 *   5. the signer certificate carries the timestamping EKU — only a certificate
 *      issued to attest to time may do so;
 *   6. a certification path is BUILT from the signer to a root in the trust
 *      store, with CA authorisation enforced at every link (see x509Path.ts),
 *      valid at the instant the token attests to.
 *
 * The CMS mechanics live in cms.ts, shared with the PKCS#7 seal inside a signed
 * PDF — the same structure, and historically the same two mistakes.
 */

export type TimestampVerification =
  | { ok: true; genTime: Date; signer: string }
  | { ok: false; reason: string };

const OID_TIMESTAMPING_EKU = "1.3.6.1.5.5.7.3.8";

/** The TSTInfo bytes, out of encapContentInfo's [0] EXPLICIT OCTET STRING. */
function tstInfoOf(signedData: Asn1): Buffer | null {
  const encap = children(signedData)[2];
  if (!encap) return null;
  const wrapper = children(encap)[1];
  const octet = wrapper ? children(wrapper)[0] : undefined;
  return octet && typeof octet.value === "string" ? Buffer.from(octet.value, "binary") : null;
}

function readTstInfo(der: Buffer): { imprint: Buffer; genTime: Date } | null {
  try {
    const seq = children(forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")), false));
    if (seq.length < 5) return null;
    const hashed = children(seq[2])[1];
    if (!hashed || typeof hashed.value !== "string") return null;
    const time = seq.find((n) => n.type === forge.asn1.Type.GENERALIZEDTIME);
    if (!time || typeof time.value !== "string") return null;
    return {
      imprint: Buffer.from(hashed.value, "binary"),
      genTime: forge.asn1.generalizedTimeToDate(time.value),
    };
  } catch {
    return null;
  }
}

function hasTimestampingEku(cert: forge.pki.Certificate): boolean {
  const eku = cert.getExtension("extKeyUsage") as { timeStamping?: boolean } | undefined;
  if (eku?.timeStamping) return true;
  const raw = cert.extensions.find((ext: { id?: string }) => ext.id === "2.5.29.37") as
    | { value?: string }
    | undefined;
  return Boolean(raw?.value && raw.value.includes(forge.asn1.oidToDer(OID_TIMESTAMPING_EKU).getBytes()));
}

export function verifyTimestampToken(tokenBase64: string, digest: Buffer): TimestampVerification {
  let signedData: Asn1 | null;
  try {
    signedData = signedDataOf(Buffer.from(tokenBase64, "base64"));
  } catch {
    return { ok: false, reason: "token is not well-formed" };
  }
  if (!signedData) return { ok: false, reason: "token carries no SignedData" };

  const tstDer = tstInfoOf(signedData);
  if (!tstDer) return { ok: false, reason: "token carries no TSTInfo" };
  const info = readTstInfo(tstDer);
  if (!info) return { ok: false, reason: "TSTInfo could not be read" };

  // 1. A perfectly valid token for a DIFFERENT document is not evidence here.
  if (!info.imprint.equals(digest)) return { ok: false, reason: "token attests to a different document" };

  const certs = certificatesOf(signedData);
  if (certs.length === 0) return { ok: false, reason: "token carries no signer certificate" };

  const signerInfo = signerInfoOf(signedData);
  if (!signerInfo) return { ok: false, reason: "token carries no signer information" };

  // 2. The signer NAMED by SignerInfo, not whichever certificate came first.
  const signer = resolveSigner(signerInfo, certs);
  if (!signer) return { ok: false, reason: "the certificate named by SignerInfo is not present in the token" };

  const attrs = signedAttributesOf(signerInfo);
  if (!attrs) return { ok: false, reason: "token has no signed attributes" };

  // 3. Those attributes must commit to THIS TSTInfo, or the signature is over
  //    something else entirely.
  const digestName = digestAlgorithmOf(signerInfo);
  const tstDigest = crypto.createHash(digestName).update(tstDer).digest();
  if (!attributesCoverContent(attrs.node, tstDigest)) {
    return { ok: false, reason: "signed attributes do not cover the timestamp" };
  }

  // 4. The signature itself.
  if (!verifyAttributeSignature(attrs, signer.parsed, digestName)) {
    return { ok: false, reason: "token signature does not verify" };
  }

  // 5. Any certificate can sign; only one issued for timestamping may attest to
  //    time.
  if (!hasTimestampingEku(signer.parsed)) {
    return { ok: false, reason: "signer certificate is not authorised for timestamping" };
  }

  // 6. What turns "somebody signed it" into "an authority you trust signed it".
  const path = verifyCertificatePath({
    leafDer: signer.der,
    poolDer: certs.map((candidate) => candidate.der),
    at: info.genTime,
  });
  if (!path.ok) return { ok: false, reason: path.reason };

  return {
    ok: true,
    genTime: info.genTime,
    signer: signer.parsed.subject.getField("CN")?.value ?? "unknown",
  };
}
