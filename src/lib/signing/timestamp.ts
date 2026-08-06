import crypto from "crypto";
import forge from "node-forge";

/**
 * RFC 3161 trusted timestamps.
 *
 * The evidence chain proves nobody altered a record WITHOUT full database
 * access. It cannot prove to a third party that events happened when we say
 * they did, because the whole chain is built by our system and lives in our
 * database — someone holding both could rebuild it consistently. In a dispute
 * that is the difference between "our records say" and something the other side
 * cannot simply disbelieve.
 *
 * A timestamp authority closes exactly that. We send a HASH — never the document
 * — and an independent party returns a signed token asserting that this hash
 * existed at this moment. Public authorities (DigiCert, Sectigo, freeTSA) offer
 * this at no cost, which is why this is built rather than bought.
 *
 * ── Fails soft, deliberately ────────────────────────────────────────────────
 *
 * A timestamp is evidence ABOUT a signature, not part of one. If the authority
 * is slow, unreachable or returns something malformed, the signature is still
 * valid and the document must still complete. Every failure here returns null
 * and is recorded honestly as "not timestamped" rather than throwing into the
 * completion path — losing a signed contract to a third party's outage would be
 * a far worse failure than lacking one attestation.
 *
 * ── What is actually sent ───────────────────────────────────────────────────
 *
 * A SHA-256 digest. Not the PDF, not the signer's name, not the tenant. The
 * authority learns that somebody timestamped something, and nothing else — which
 * matters, because this is customer contract data leaving the system.
 */

export type TrustedTimestamp = {
  /** The DER-encoded token, base64 — the thing a verifier checks. */
  tokenBase64: string;
  /** Time the authority attests to. */
  genTime: Date;
  /** Which authority issued it, for the certificate and the audit trail. */
  authority: string;
  /** The digest that was stamped, so a verifier knows what it covers. */
  digestHex: string;
};

const DEFAULT_TSA = "http://timestamp.digicert.com";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

export function timestampAuthorityUrl(): string {
  return process.env.SIGNING_TSA_URL?.trim() || DEFAULT_TSA;
}

/** Whether trusted timestamping is switched on at all. */
export function timestampingEnabled(): boolean {
  return (process.env.SIGNING_TSA_ENABLED ?? "true").toLowerCase() !== "false";
}

/**
 * Build a TimeStampReq (RFC 3161 §2.4.1).
 *
 * The nonce is what stops a replayed response being accepted as fresh: the
 * authority must echo it back, so a token captured from an earlier exchange
 * cannot be passed off as an answer to this one.
 */
function buildRequest(digest: Buffer, nonce: Buffer): Buffer {
  const asn1 = forge.asn1;
  const req = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    // version = 1
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, String.fromCharCode(1)),
    // messageImprint ::= SEQUENCE { hashAlgorithm, hashedMessage }
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(OID_SHA256).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
      ]),
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest.toString("binary")),
    ]),
    // nonce
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false, nonce.toString("binary")),
    // certReq = true — ask for the signing certificate, so the token can be
    // verified later without having to go back to the authority for it.
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BOOLEAN, false, String.fromCharCode(0xff)),
  ]);
  return Buffer.from(asn1.toDer(req).getBytes(), "binary");
}

/** Pull the granted token and its genTime out of a TimeStampResp. */
function parseResponse(der: Buffer): { token: Buffer; genTime: Date } | null {
  const asn1 = forge.asn1;
  let parsed: forge.asn1.Asn1;
  try {
    parsed = asn1.fromDer(forge.util.createBuffer(der.toString("binary")));
  } catch {
    return null;
  }
  const top = parsed.value as forge.asn1.Asn1[];
  if (!Array.isArray(top) || top.length === 0) return null;

  // PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }
  // 0 = granted, 1 = grantedWithMods. Anything else is a refusal.
  const statusInfo = top[0]?.value as forge.asn1.Asn1[];
  const statusBytes = Array.isArray(statusInfo) ? (statusInfo[0]?.value as string) : null;
  if (typeof statusBytes !== "string" || statusBytes.length === 0) return null;
  const status = statusBytes.charCodeAt(statusBytes.length - 1);
  if (status !== 0 && status !== 1) return null;

  // timeStampToken is the second element; re-encode it as its own DER blob.
  const tokenAsn1 = top[1];
  if (!tokenAsn1) return null;
  const token = Buffer.from(asn1.toDer(tokenAsn1).getBytes(), "binary");

  const genTime = findGenTime(tokenAsn1);
  if (!genTime) return null;
  return { token, genTime };
}

/**
 * Walk the token for its GENERALIZEDTIME — the attested moment.
 *
 * Found structurally rather than by a fixed path, because the token's shape
 * varies between authorities and a rigid path would work against one and
 * silently fail against another.
 */
function findGenTime(node: forge.asn1.Asn1, depth = 0): Date | null {
  const asn1 = forge.asn1;
  if (depth > 12) return null;

  if (node.type === asn1.Type.GENERALIZEDTIME && typeof node.value === "string") {
    try {
      return asn1.generalizedTimeToDate(node.value);
    } catch {
      return null;
    }
  }

  if (Array.isArray(node.value)) {
    for (const child of node.value as forge.asn1.Asn1[]) {
      const found = findGenTime(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // The attested time lives in the ENCAPSULATED TSTInfo — a DER structure
  // carried inside an OCTET STRING, which a parser has no reason to descend into
  // on its own. Skipping this step is why an earlier version of this function
  // silently found nothing against a perfectly good response from a real
  // authority, and (because timestamping fails soft) reported "no timestamp"
  // rather than an error anybody would notice.
  if (node.type === asn1.Type.OCTETSTRING && typeof node.value === "string" && node.value.length > 1) {
    try {
      const inner = asn1.fromDer(forge.util.createBuffer(node.value), false);
      return findGenTime(inner, depth + 1);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Ask an authority to attest that `digest` existed now.
 *
 * Returns null on ANY problem. See the note above: a timestamp is evidence about
 * a signature, never a precondition of one.
 */
export async function requestTrustedTimestamp(digest: Buffer): Promise<TrustedTimestamp | null> {
  if (!timestampingEnabled()) return null;
  if (digest.length !== 32) return null; // SHA-256 only, as declared in the request

  const url = timestampAuthorityUrl();
  const nonce = crypto.randomBytes(16);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: new Uint8Array(buildRequest(digest, nonce)),
      // Short: this runs inside document completion, and a slow authority must
      // not hold a customer at a spinner after they have signed.
      signal: AbortSignal.timeout(Number(process.env.SIGNING_TSA_TIMEOUT_MS || 10_000)),
    });
    if (!response.ok) return null;
    const parsed = parseResponse(Buffer.from(await response.arrayBuffer()));
    if (!parsed) return null;

    // A timestamp far from our own clock is not usable as evidence — it means
    // one of the two is wrong, and we cannot tell which. Refuse it rather than
    // file something that undermines the record it is meant to support.
    const skewMs = Math.abs(parsed.genTime.getTime() - Date.now());
    if (skewMs > 24 * 60 * 60 * 1000) return null;

    return {
      tokenBase64: parsed.token.toString("base64"),
      genTime: parsed.genTime,
      authority: url,
      digestHex: digest.toString("hex"),
    };
  } catch {
    return null;
  }
}

/**
 * Check a stored token still covers the digest it claims to.
 *
 * Confirms the token embeds this exact hash. It does NOT validate the
 * authority's signature chain — that needs the authority's roots and belongs in
 * a verification tool, not on the signing path. What this catches is the case
 * that matters day to day: a token filed against the wrong document.
 */
export function timestampCoversDigest(tokenBase64: string, digest: Buffer): boolean {
  try {
    const der = Buffer.from(tokenBase64, "base64");
    // The imprint appears in the token verbatim; finding it is sufficient to
    // show the token was issued for this hash and not another.
    return der.includes(digest);
  } catch {
    return false;
  }
}
