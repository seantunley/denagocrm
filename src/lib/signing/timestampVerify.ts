import crypto from "crypto";
import tls from "node:tls";
import forge from "node-forge";

/**
 * Cryptographic validation of an RFC 3161 timestamp token.
 *
 * Without this, a stored token proves nothing: the system asked an authority for
 * an attestation, kept whatever came back, and checked only that the document's
 * digest appeared in it. Over plain HTTP — which is what public authorities
 * serve — anyone on the path could have supplied a plausible reply.
 *
 * ── Why this is hand-parsed ─────────────────────────────────────────────────
 *
 * node-forge's pkcs7 reader refuses these outright: "Only wrapped ContentType
 * Data supported". An RFC 3161 token encapsulates `id-ct-TSTInfo`, not `Data`,
 * so the library cannot open it at all. An earlier attempt at this file used
 * that reader and rejected every genuine token — worse than useless, because it
 * would have quietly reported every document as unstamped. So the SignedData is
 * walked directly.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 *
 *   1. the encapsulated TSTInfo's message imprint IS this document's digest;
 *   2. the signed attributes carry a messageDigest over that TSTInfo;
 *   3. the signature over those attributes verifies under the signer's key;
 *   4. the signer certificate carries the timestamping EKU — only a certificate
 *      issued to attest to time may do so;
 *   5. it chains to a root in the trust store;
 *   6. the attested time falls inside the certificate's validity window.
 *
 * Trust comes from `tls.rootCertificates`, the Mozilla store Node ships — the
 * same set a browser trusts, with no purchase and no key material to look after.
 * SIGNING_TSA_ROOTS_PEM adds roots for a private authority; it only ever ADDS,
 * so a misconfiguration cannot silently narrow trust to nothing.
 */

export type TimestampVerification =
  | { ok: true; genTime: Date; signer: string }
  | { ok: false; reason: string };

const OID_TIMESTAMPING_EKU = "1.3.6.1.5.5.7.3.8";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";

let cachedRoots: crypto.X509Certificate[] | null = null;
function trustedRoots(): crypto.X509Certificate[] {
  if (cachedRoots) return cachedRoots;
  const roots: crypto.X509Certificate[] = [];
  for (const pem of tls.rootCertificates) {
    try { roots.push(new crypto.X509Certificate(pem)); } catch { /* skip */ }
  }
  for (const block of (process.env.SIGNING_TSA_ROOTS_PEM ?? "").split(/(?=-----BEGIN CERTIFICATE-----)/g)) {
    const trimmed = block.trim();
    if (trimmed) { try { roots.push(new crypto.X509Certificate(trimmed)); } catch { /* skip */ } }
  }
  cachedRoots = roots;
  return roots;
}

/**
 * Walk the chain with Node's X509, not forge.
 *
 * forge refuses these certificates outright — "Certificate has an unsupported
 * critical extension" — on a chain that is perfectly valid and which a browser
 * accepts. Verifying with a library that cannot read the certificates would have
 * rejected every genuine token, which is the failure mode this whole file exists
 * to avoid repeating.
 *
 * Each certificate must be issued by, and carry a signature verifiable under,
 * the next one; the last must be issued by a root in the trust store. A chain
 * that merely "looks right" by subject name is not enough — every link is a
 * signature check.
 */
function verifyChainToTrustedRoot(chainDer: Buffer[]): { ok: true } | { ok: false; reason: string } {
  try {
    const chain = chainDer.map((der) => new crypto.X509Certificate(der));
    if (chain.length === 0) return { ok: false, reason: "empty certificate chain" };

    for (let i = 0; i < chain.length - 1; i += 1) {
      if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
        return { ok: false, reason: `certificate ${i} is not validly issued by the next in the chain` };
      }
    }

    const top = chain[chain.length - 1];
    for (const root of trustedRoots()) {
      // A self-issued top that IS a trusted root also terminates the chain.
      if (top.raw.equals(root.raw)) return { ok: true };
      if (top.checkIssued(root) && top.verify(root.publicKey)) return { ok: true };
    }
    return { ok: false, reason: "chain does not terminate at a trusted root" };
  } catch (error) {
    return {
      ok: false,
      reason: `chain could not be checked: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160),
    };
  }
}

type Asn1 = forge.asn1.Asn1;
const children = (node: Asn1): Asn1[] => (Array.isArray(node.value) ? (node.value as Asn1[]) : []);

/** SignedData sits inside ContentInfo's [0] EXPLICIT wrapper. */
function signedDataOf(token: Buffer): Asn1 | null {
  try {
    const root = forge.asn1.fromDer(forge.util.createBuffer(token.toString("binary")), false);
    const wrapper = children(root)[1];
    return wrapper ? children(wrapper)[0] ?? null : null;
  } catch {
    return null;
  }
}

function derOf(node: Asn1): Buffer {
  return Buffer.from(forge.asn1.toDer(node).getBytes(), "binary");
}

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
    const hashed = children(children(seq[2])[1] ? seq[2] : seq[2])[1];
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

/** Certificates live in the [0] IMPLICIT element after encapContentInfo. */
function certificatesOf(signedData: Asn1): forge.pki.Certificate[] {
  const out: forge.pki.Certificate[] = [];
  for (const node of children(signedData)) {
    if (node.type !== 0 || node.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC) continue;
    for (const candidate of children(node)) {
      try { out.push(forge.pki.certificateFromAsn1(candidate)); } catch { /* not a certificate */ }
    }
  }
  return out;
}

/** SignerInfo is the last element: a SET OF, from which we take the first. */
function signerInfoOf(signedData: Asn1): Asn1 | null {
  const kids = children(signedData);
  const set = kids[kids.length - 1];
  return set ? children(set)[0] ?? null : null;
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
  const signer = certs[0];

  const signerInfo = signerInfoOf(signedData);
  if (!signerInfo) return { ok: false, reason: "token carries no signer information" };

  // The [0] IMPLICIT signed attributes, and the signature over them.
  const infoKids = children(signerInfo);
  const signedAttrs = infoKids.find(
    (n) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === 0,
  );
  const signature = [...infoKids].reverse().find(
    (n) => n.type === forge.asn1.Type.OCTETSTRING && typeof n.value === "string",
  );
  if (!signedAttrs || !signature || typeof signature.value !== "string") {
    return { ok: false, reason: "token has no signed attributes" };
  }

  // 2. Those attributes must commit to THIS TSTInfo, or the signature is over
  //    something else entirely.
  const tstDigest = crypto.createHash("sha256").update(tstDer).digest();
  const commits = children(signedAttrs).some((attr) => {
    const parts = children(attr);
    const oid = parts[0] && typeof parts[0].value === "string"
      ? forge.asn1.derToOid(parts[0].value)
      : null;
    if (oid !== OID_MESSAGE_DIGEST) return false;
    return children(parts[1] ?? attr).some(
      (v) => typeof v.value === "string" && Buffer.from(v.value, "binary").equals(tstDigest),
    );
  });
  if (!commits) return { ok: false, reason: "signed attributes do not cover the timestamp" };

  // 3. CMS signs the signed attributes re-tagged from [0] IMPLICIT to a
  //    universal SET. Reconstructing that exactly is the whole job.
  const asSet = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, children(signedAttrs),
  );
  try {
    const verified = crypto
      .createVerify("RSA-SHA256")
      .update(derOf(asSet))
      .verify(
        forge.pki.publicKeyToPem(signer.publicKey as forge.pki.rsa.PublicKey),
        Buffer.from(signature.value, "binary"),
      );
    if (!verified) return { ok: false, reason: "token signature does not verify" };
  } catch {
    return { ok: false, reason: "token signature could not be checked" };
  }

  // 4. Any certificate can sign; only one issued for timestamping may attest to
  //    time.
  const eku = signer.getExtension("extKeyUsage") as { timeStamping?: boolean } | undefined;
  if (!eku?.timeStamping) {
    const raw = signer.extensions.find((ext: { id?: string }) => ext.id === "2.5.29.37") as
      | { value?: string } | undefined;
    if (!raw?.value || !raw.value.includes(forge.asn1.oidToDer(OID_TIMESTAMPING_EKU).getBytes())) {
      return { ok: false, reason: "signer certificate is not authorised for timestamping" };
    }
  }

  // 6. A time signed before issue or after expiry is not something the issuer
  //    stood behind.
  if (info.genTime < signer.validity.notBefore || info.genTime > signer.validity.notAfter) {
    return { ok: false, reason: "attested time is outside the signer certificate's validity" };
  }

  // 5. What turns "somebody signed it" into "an authority you trust signed it".
  const chain = verifyChainToTrustedRoot(certs.map((c) => derOf(forge.pki.certificateToAsn1(c))));
  if (!chain.ok) return { ok: false, reason: chain.reason };

  return {
    ok: true,
    genTime: info.genTime,
    signer: signer.subject.getField("CN")?.value ?? "unknown",
  };
}
