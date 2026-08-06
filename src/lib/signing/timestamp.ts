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

// HTTP, and that is not an oversight.
//
// Public timestamp authorities serve RFC 3161 over plain HTTP by design: the
// token is signed by the authority, so transport gives it no integrity it does
// not already have, and DigiCert's endpoint does not answer on HTTPS at all.
// Requiring TLS here therefore does not harden anything — it disables
// timestamping outright, and because this path fails soft, it would do so
// silently, leaving every document unstamped with no error anywhere. (I made
// exactly that change and caught it only by calling the real authority.)
//
// What plain HTTP does cost is confidentiality of the exchange: an observer
// learns that a hash was stamped and when, though not what it is a hash OF.
// Set SIGNING_TSA_URL to an HTTPS authority if that matters to you.
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
/** Pull the message imprint and nonce out of the TSTInfo. */
function readTstInfo(node: forge.asn1.Asn1, depth = 0): { imprint: Buffer | null; nonce: Buffer | null } {
  const asn1 = forge.asn1;
  const out: { imprint: Buffer | null; nonce: Buffer | null } = { imprint: null, nonce: null };
  if (depth > 12) return out;

  if (node.type === asn1.Type.OCTETSTRING && typeof node.value === "string" && node.value.length > 1) {
    try {
      const inner = asn1.fromDer(forge.util.createBuffer(node.value), false);
      // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber,
      //                        genTime, [accuracy], [ordering], [nonce], ... }
      const seq = inner.value as forge.asn1.Asn1[];
      if (Array.isArray(seq) && seq.length >= 4) {
        const imprintSeq = seq[2]?.value as forge.asn1.Asn1[] | undefined;
        const hashed = Array.isArray(imprintSeq) ? imprintSeq[1] : undefined;
        if (hashed && typeof hashed.value === "string") out.imprint = Buffer.from(hashed.value, "binary");
        // The nonce is the INTEGER following genTime, when the responder echoes it.
        for (let index = 4; index < seq.length; index += 1) {
          const candidate = seq[index];
          if (candidate?.type === asn1.Type.INTEGER && typeof candidate.value === "string") {
            out.nonce = Buffer.from(candidate.value, "binary");
          }
        }
      }
      if (out.imprint) return out;
    } catch { /* not a nested structure; keep walking */ }
  }
  if (Array.isArray(node.value)) {
    for (const child of node.value as forge.asn1.Asn1[]) {
      const found = readTstInfo(child, depth + 1);
      if (found.imprint) return found;
    }
  }
  return out;
}

function parseResponse(der: Buffer): { token: Buffer; genTime: Date; imprint: Buffer | null; nonce: Buffer | null } | null {
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
  const { imprint, nonce } = readTstInfo(tokenAsn1);
  return { token, genTime, imprint, nonce };
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

    // WHAT THE TOKEN ACTUALLY SAYS, parsed — not "the bytes appear somewhere".
    //
    // An earlier version stored whatever came back and checked coverage by
    // searching the DER for the digest, which a token for a different document
    // (or an arbitrary blob containing those bytes) satisfies. That is not proof
    // of anything, and describing it as independent attestation was wrong.
    //
    // The imprint is read out of the TSTInfo and compared, and the nonce we sent
    // must be echoed — that is what stops a captured response from an earlier
    // exchange being replayed as an answer to this one.
    if (!parsed.imprint || !parsed.imprint.equals(digest)) return null;
    if (!parsed.nonce || !parsed.nonce.equals(nonce)) return null;

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
 * Does this stored token attest to this exact document?
 *
 * Reads the message imprint OUT OF the TSTInfo and compares it. An earlier
 * version searched the DER for the digest bytes, which a token issued for a
 * different document can satisfy by coincidence and an arbitrary blob can
 * satisfy on purpose.
 *
 * ── What this still does NOT do ─────────────────────────────────────────────
 *
 * It does not validate the CMS signature, the authority's certificate chain, or
 * the timestamping EKU against trusted roots.
 *
 * So a stored token currently proves NOTHING on its own. An earlier version of
 * this comment said it "proves the authority issued it for this hash" — that is
 * wrong, and wrong in the direction that matters. The response signature is not
 * checked, and the transport is plain HTTP, so an active network attacker can
 * fabricate a reply carrying the imprint and nonce we sent and a time of their
 * choosing. The imprint and nonce checks stop a token for ANOTHER document or a
 * replayed older response from being accepted; they do not establish that a
 * timestamp authority produced it at all.
 *
 * Until the CMS signature and chain are validated, treat this as a convenience
 * record, not evidence — and do not let any customer-facing wording imply
 * otherwise.
 */
export function timestampCoversDigest(tokenBase64: string, digest: Buffer): boolean {
  try {
    const der = Buffer.from(tokenBase64, "base64");
    const parsed = forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")), false);
    const { imprint } = readTstInfo(parsed);
    return Boolean(imprint && imprint.equals(digest));
  } catch {
    return false;
  }
}
