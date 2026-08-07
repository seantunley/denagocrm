import crypto from "crypto";
import forge from "node-forge";

/**
 * The CMS / PKCS#7 primitives shared by the two things that carry one: an
 * RFC 3161 timestamp token, and the PKCS#7 seal inside a signed PDF.
 *
 * Both were originally handled by separate ad-hoc code, and both made the same
 * two mistakes — taking `certificates[0]` as the signer, and treating "a
 * certificate came back" as "the signature checks out". They are the same
 * structure, so they get one implementation.
 *
 * node-forge is used to PARSE (it is good at that, and it reads certificates
 * OpenSSL-based code and forge's own verifier both refuse) and Node's crypto is
 * used to VERIFY. forge's `pkcs7.messageFromAsn1` cannot open a timestamp token
 * at all — "Only wrapped ContentType Data supported" — so the structure is
 * walked by hand.
 */

export type Asn1 = forge.asn1.Asn1;
export const children = (node: Asn1): Asn1[] => (Array.isArray(node.value) ? (node.value as Asn1[]) : []);
export const derOf = (node: Asn1): Buffer => Buffer.from(forge.asn1.toDer(node).getBytes(), "binary");

export const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
export const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";

export type CmsCertificate = { der: Buffer; parsed: forge.pki.Certificate };

/**
 * Cut a DER blob down to the length its own header declares.
 *
 * A PDF signature placeholder is a FIXED-WIDTH hex field — 8 KB of it, with the
 * real structure at the front and zeroes for the rest. forge refuses the whole
 * buffer, and the refusal is indistinguishable from "this file is not signed",
 * so every sealed PDF read back looked unsigned.
 */
export function trimToDerLength(der: Buffer): Buffer {
  if (der.length < 2) return der;
  const first = der[1];
  if (first < 0x80) return der.subarray(0, 2 + first);
  const count = first & 0x7f;
  if (count === 0 || count > 4 || der.length < 2 + count) return der;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + der[2 + i];
  const total = 2 + count + length;
  return total <= der.length ? der.subarray(0, total) : der;
}

/** ContentInfo → [0] EXPLICIT → SignedData. */
export function signedDataOf(der: Buffer): Asn1 | null {
  try {
    const trimmed = trimToDerLength(der);
    const root = forge.asn1.fromDer(forge.util.createBuffer(trimmed.toString("binary")), false);
    const wrapper = children(root)[1];
    return wrapper ? children(wrapper)[0] ?? null : null;
  } catch {
    return null;
  }
}

/** Certificates live in the [0] IMPLICIT element after encapContentInfo. */
export function certificatesOf(signedData: Asn1): CmsCertificate[] {
  const out: CmsCertificate[] = [];
  for (const node of children(signedData)) {
    if (node.type !== 0 || node.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC) continue;
    for (const candidate of children(node)) {
      try {
        out.push({ der: derOf(candidate), parsed: forge.pki.certificateFromAsn1(candidate) });
      } catch {
        /* not a certificate, or one forge cannot read */
      }
    }
  }
  return out;
}

/** SignerInfos is the last element: a SET OF, from which we take the first. */
export function signerInfoOf(signedData: Asn1): Asn1 | null {
  const kids = children(signedData);
  const set = kids[kids.length - 1];
  return set ? children(set)[0] ?? null : null;
}

/** A certificate's own issuer name (as DER) and serial number, read from its TBS. */
function issuerAndSerialOf(certDer: Buffer): { issuerDer: Buffer; serial: string } | null {
  try {
    const cert = forge.asn1.fromDer(forge.util.createBuffer(certDer.toString("binary")), false);
    const kids = children(children(cert)[0]);
    // TBSCertificate: [0] EXPLICIT version is OPTIONAL, so the offset moves.
    const offset =
      kids[0] && kids[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && kids[0].type === 0 ? 1 : 0;
    const serial = kids[offset];
    const issuer = kids[offset + 2];
    if (!serial || typeof serial.value !== "string" || !issuer) return null;
    return { issuerDer: derOf(issuer), serial: Buffer.from(serial.value, "binary").toString("hex") };
  } catch {
    return null;
  }
}

/**
 * WHICH certificate signed this message.
 *
 * Taking `certificates[0]` and hoping is wrong twice over: CMS does not promise
 * an order, and a message may legitimately carry intermediates or unrelated
 * certificates alongside the signer. SignerInfo names the signer explicitly —
 * by issuer-and-serial, or by subject key identifier — so that is what is
 * honoured. Guessing wrong means verifying a real signature against the wrong
 * identity and then reporting whatever that certificate happened to say.
 */
export function resolveSigner(signerInfo: Asn1, certs: CmsCertificate[]): CmsCertificate | null {
  const sid = children(signerInfo)[1];
  if (!sid) return null;

  // [0] IMPLICIT SubjectKeyIdentifier
  if (sid.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && sid.type === 0) {
    if (typeof sid.value !== "string") return null;
    const wanted = Buffer.from(sid.value, "binary").toString("hex").toLowerCase();
    for (const candidate of certs) {
      const ski = candidate.parsed.getExtension("subjectKeyIdentifier") as
        | { subjectKeyIdentifier?: string }
        | undefined;
      if (ski?.subjectKeyIdentifier && ski.subjectKeyIdentifier.toLowerCase() === wanted) return candidate;
    }
    return null;
  }

  // IssuerAndSerialNumber ::= SEQUENCE { issuer Name, serialNumber INTEGER }
  const parts = children(sid);
  const issuer = parts[0];
  const serialNode = parts[1];
  if (!issuer || !serialNode || typeof serialNode.value !== "string") return null;
  const wantedIssuer = derOf(issuer);
  const wantedSerial = Buffer.from(serialNode.value, "binary").toString("hex");

  for (const candidate of certs) {
    const identity = issuerAndSerialOf(candidate.der);
    if (identity && identity.serial === wantedSerial && identity.issuerDer.equals(wantedIssuer)) {
      return candidate;
    }
  }
  return null;
}

const DIGESTS: Record<string, string> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};

/** The digest the signer declared, so the content digest is computed the same way. */
export function digestAlgorithmOf(signerInfo: Asn1): string {
  const algorithm = children(signerInfo)[2];
  const oidNode = algorithm ? children(algorithm)[0] : undefined;
  if (oidNode && typeof oidNode.value === "string") {
    const name = DIGESTS[forge.asn1.derToOid(oidNode.value)];
    if (name) return name;
  }
  return "sha256";
}

export type SignedAttributes = { node: Asn1; signature: Buffer };

/** The [0] IMPLICIT signed attributes and the signature over them. */
export function signedAttributesOf(signerInfo: Asn1): SignedAttributes | null {
  const kids = children(signerInfo);
  const node = kids.find((n) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === 0);
  const signature = [...kids].reverse().find(
    (n) => n.type === forge.asn1.Type.OCTETSTRING && typeof n.value === "string",
  );
  if (!node || !signature || typeof signature.value !== "string") return null;
  return { node, signature: Buffer.from(signature.value, "binary") };
}

/** The raw value of one signed attribute, by OID. */
export function signedAttribute(attrs: Asn1, oid: string): Asn1 | null {
  for (const attr of children(attrs)) {
    const parts = children(attr);
    const id = parts[0] && typeof parts[0].value === "string" ? forge.asn1.derToOid(parts[0].value) : null;
    if (id === oid) return children(parts[1] ?? attr)[0] ?? null;
  }
  return null;
}

/**
 * Do the signed attributes commit to THIS content?
 *
 * Without it the signature is over a set of attributes that could describe any
 * document at all — the messageDigest attribute is the only thing tying the
 * signature to the bytes.
 */
export function attributesCoverContent(attrs: Asn1, contentDigest: Buffer): boolean {
  const value = signedAttribute(attrs, OID_MESSAGE_DIGEST);
  return Boolean(value && typeof value.value === "string" && Buffer.from(value.value, "binary").equals(contentDigest));
}

/**
 * Verify the signature over the signed attributes.
 *
 * CMS signs the attributes re-tagged from [0] IMPLICIT to a universal SET.
 * Reconstructing that exactly is the whole job — sign the [0] form and nothing
 * verifies, which is indistinguishable from a forged document.
 */
export function verifyAttributeSignature(
  attrs: SignedAttributes,
  cert: forge.pki.Certificate,
  digest: string,
): boolean {
  try {
    const asSet = forge.asn1.create(
      forge.asn1.Class.UNIVERSAL,
      forge.asn1.Type.SET,
      true,
      children(attrs.node),
    );
    return crypto
      .createVerify(`RSA-${digest.toUpperCase()}`)
      .update(derOf(asSet))
      .verify(forge.pki.publicKeyToPem(cert.publicKey as forge.pki.rsa.PublicKey), attrs.signature);
  } catch {
    return false;
  }
}
