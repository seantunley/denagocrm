import crypto from "crypto";
import tls from "node:tls";
import forge from "node-forge";

/**
 * X.509 certification path building and validation.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The first version of the timestamp verifier walked the certificates in the
 * order the token happened to list them and checked only two things per link:
 *
 *     child.checkIssued(parent) && child.verify(parent.publicKey)
 *
 * That is not path validation, and the gap is not theoretical. `checkIssued()`
 * compares names — it establishes a POSSIBLE issuer relationship, nothing more —
 * and `verify()` only asks whether that key produced the signature. Neither asks
 * the question that matters: *was this certificate ever authorised to issue
 * certificates at all?*
 *
 * So an ordinary end-entity certificate — a web server's, anybody's — could be
 * placed in an intermediate position and be accepted, because its private key
 * can mathematically sign another certificate just as well as a CA's can. Trust
 * would then rest on "somebody with a certificate signed this", which is not a
 * meaningful statement. Probing the real DigiCert timestamp chain shows exactly
 * the distinction being missed:
 *
 *     signer        ca=false  keyCertSign=false  basicConstraints cA=false
 *     intermediate  ca=true   keyCertSign=true   basicConstraints cA=true, pathLen=0
 *
 * This file enforces the difference, and builds the path rather than assuming
 * the token listed it in order — CMS does not promise an order, and a producer
 * is free to shuffle or include unrelated certificates.
 *
 * ── Why the work is split across two libraries ──────────────────────────────
 *
 * Neither library can do this alone, and both failures were found by running
 * against real certificates rather than by reading documentation:
 *
 *   - node-forge cannot VERIFY this chain: `verifyCertificateChain` throws
 *     "Certificate has an unsupported critical extension" on certificates a
 *     browser accepts without complaint. It parses them fine.
 *   - Node's X509Certificate verifies signatures and exposes `.ca`, but its
 *     `.keyUsage` property is the EXTENDED key usage OID list — it is
 *     `undefined` on a root that has no EKU extension — so it cannot answer
 *     "may this certificate sign other certificates?".
 *
 * Signatures, validity and `ca` therefore come from Node; the KeyUsage bits and
 * the basicConstraints path length come from forge's parse of the same bytes.
 */

const MAX_PATH_DEPTH = 8;

export type PathResult =
  | { ok: true; chain: crypto.X509Certificate[] }
  | { ok: false; reason: string };

type Candidate = {
  x509: crypto.X509Certificate;
  der: Buffer;
  /** Present only when forge could parse it; absent means "cannot vouch for it". */
  forge: forge.pki.Certificate | null;
};

let cachedRoots: Map<string, crypto.X509Certificate[]> | null = null;

/**
 * The Mozilla trust store Node ships, plus any private roots the operator adds.
 *
 * SIGNING_TSA_ROOTS_PEM only ever ADDS. A malformed value can therefore fail to
 * widen trust, but it can never silently narrow it to nothing — a
 * misconfiguration that quietly trusted no one would disable verification while
 * appearing to work, which is the failure nobody notices.
 */
function trustedRootsBySubject(): Map<string, crypto.X509Certificate[]> {
  if (cachedRoots) return cachedRoots;
  const map = new Map<string, crypto.X509Certificate[]>();
  const add = (pem: string) => {
    try {
      const cert = new crypto.X509Certificate(pem);
      const list = map.get(cert.subject) ?? [];
      list.push(cert);
      map.set(cert.subject, list);
    } catch {
      /* a root we cannot parse is simply not a root we can use */
    }
  };
  for (const pem of tls.rootCertificates) add(pem);
  for (const block of (process.env.SIGNING_TSA_ROOTS_PEM ?? "").split(/(?=-----BEGIN CERTIFICATE-----)/g)) {
    const trimmed = block.trim();
    if (trimmed) add(trimmed);
  }
  cachedRoots = map;
  return map;
}

/** Test seam: the root set is cached, and tests need to change the environment. */
export function resetTrustedRootCache(): void {
  cachedRoots = null;
}

function toCandidate(der: Buffer): Candidate | null {
  try {
    const x509 = new crypto.X509Certificate(der);
    let parsed: forge.pki.Certificate | null = null;
    try {
      parsed = forge.pki.certificateFromAsn1(
        forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")), false),
      );
    } catch {
      parsed = null;
    }
    return { x509, der, forge: parsed };
  } catch {
    return null;
  }
}

function validAt(cert: crypto.X509Certificate, at: Date): boolean {
  const from = new Date(cert.validFrom);
  const to = new Date(cert.validTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return false;
  return at >= from && at <= to;
}

/**
 * May this certificate issue certificates, and how far below it may the path go?
 *
 * RFC 5280 §4.2.1.3: when a KeyUsage extension is present and keyCertSign is not
 * asserted, the key MUST NOT be used to verify a certificate signature — so a
 * present-but-negative KeyUsage is a refusal, while an absent one falls back to
 * basicConstraints alone (which is how many roots are issued).
 */
function certificateAuthority(candidate: Candidate): { ok: true; pathLen: number | null } | { ok: false; reason: string } {
  if (candidate.forge) {
    // KeyUsage FIRST, so a certificate that is refused for withholding
    // keyCertSign says so. Node's `.ca` already folds this rule in (OpenSSL's
    // X509_check_ca calls ku_reject before anything else), which means checking
    // `.ca` first would report every such certificate as merely "not a CA" and
    // hide why.
    const keyUsage = candidate.forge.getExtension("keyUsage") as { keyCertSign?: boolean } | undefined;
    if (keyUsage && keyUsage.keyCertSign !== true) {
      return { ok: false, reason: "carries a KeyUsage extension that withholds keyCertSign" };
    }
    // RFC 5280 §4.2.1.9: a CA certificate MUST carry basicConstraints with
    // cA=true. `.ca` alone is not enough here — with basicConstraints absent,
    // OpenSSL falls back to v1/Netscape-era heuristics that can still answer
    // "CA", and an intermediate arriving inside a signed message has no business
    // relying on those.
    const basic = candidate.forge.getExtension("basicConstraints") as
      | { cA?: boolean; pathLenConstraint?: number }
      | undefined;
    if (!basic) return { ok: false, reason: "has no basicConstraints extension, so it is not a certificate authority" };
    if (basic.cA !== true) return { ok: false, reason: "is not a certificate authority (basicConstraints cA is not true)" };
    if (!candidate.x509.ca) return { ok: false, reason: "is not usable as a certificate authority" };
    return { ok: true, pathLen: typeof basic.pathLenConstraint === "number" ? basic.pathLenConstraint : null };
  }

  // forge could not parse it. Refusing outright would be the "reject every
  // genuine token" failure this module has already produced twice, so fall back
  // to Node's judgement — which does require keyCertSign and basicConstraints
  // in the ordinary case — and simply cannot offer a path length.
  if (!candidate.x509.ca) return { ok: false, reason: "is not a certificate authority (basicConstraints cA is not true)" };
  return { ok: true, pathLen: null };
}

/** Cheap name comparison used to SELECT candidates. Never a trust decision. */
function namesLineUp(child: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  return child.issuer === issuer.subject;
}

/**
 * The real link check: the issuer's key produced this signature, and OpenSSL
 * also accepts the pairing.
 *
 * `checkIssued()` is kept as an ADDITIONAL gate, not the only one. It does more
 * than its name suggests — OpenSSL's X509_check_issued cross-checks the
 * authority/subject key identifiers and rejects an issuer whose KeyUsage
 * withholds keyCertSign — but it does NOT check basicConstraints, so a
 * certificate with cA=false and no KeyUsage extension at all passes it. That is
 * precisely the case the explicit authority check above exists to refuse, and it
 * is why the order here matters: this runs last, so a refusal is reported with
 * the reason that actually applies rather than a generic "no path".
 */
function signatureLinks(child: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  try {
    return child.verify(issuer.publicKey) && child.checkIssued(issuer);
  } catch {
    return false;
  }
}

/**
 * Build a path from `leafDer` to a certificate in the trust store, validating
 * every link at the instant `at`.
 *
 * `poolDer` are the certificates the message carried. They are CANDIDATES, not a
 * chain: the path is built by searching them, so a shuffled, padded or partial
 * bag still validates when a real path exists through it, and a bag that merely
 * looks like a chain does not.
 */
export function verifyCertificatePath(options: {
  leafDer: Buffer;
  poolDer: Buffer[];
  at: Date;
}): PathResult {
  const leaf = toCandidate(options.leafDer);
  if (!leaf) return { ok: false, reason: "the signer certificate could not be parsed" };
  if (!validAt(leaf.x509, options.at)) {
    return { ok: false, reason: "the signer certificate was not valid at the attested time" };
  }

  const pool: Candidate[] = [];
  for (const der of options.poolDer) {
    const candidate = toCandidate(der);
    // Skip the leaf itself so it can never also serve as its own issuer.
    if (candidate && !candidate.der.equals(leaf.der)) pool.push(candidate);
  }

  const roots = trustedRootsBySubject();
  const chain: crypto.X509Certificate[] = [leaf.x509];
  const used = new Set<string>([leaf.der.toString("base64")]);
  let current = leaf;

  for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
    // Terminate as soon as a trusted root vouches for the current certificate.
    for (const root of roots.get(current.x509.issuer) ?? []) {
      if (!root.ca) continue;
      if (!validAt(root, options.at)) continue;
      if (signatureLinks(current.x509, root)) {
        chain.push(root);
        return { ok: true, chain };
      }
    }

    // A self-issued certificate that is NOT in the store is a dead end, not a
    // root. Following it would let a token supply its own anchor.
    let next: Candidate | null = null;
    let failure = "";
    for (const candidate of pool) {
      if (used.has(candidate.der.toString("base64"))) continue;
      // Name match SELECTS a candidate to examine; it decides nothing.
      if (!namesLineUp(current.x509, candidate.x509)) continue;

      const authority = certificateAuthority(candidate);
      if (!authority.ok) {
        // THE GAP THIS FILE CLOSES. Being able to sign is not being allowed to.
        failure = `an issuing certificate ("${candidate.x509.subject}") ${authority.reason}`;
        continue;
      }
      if (!validAt(candidate.x509, options.at)) {
        failure = `an issuing certificate ("${candidate.x509.subject}") was not valid at the attested time`;
        continue;
      }
      // pathLenConstraint counts the intermediates permitted BELOW this one.
      const intermediatesBelow = chain.length - 1;
      if (authority.pathLen !== null && authority.pathLen < intermediatesBelow) {
        failure = `an issuing certificate ("${candidate.x509.subject}") permits only ${authority.pathLen} intermediate(s) below it`;
        continue;
      }
      if (!signatureLinks(current.x509, candidate.x509)) {
        failure = `an issuing certificate ("${candidate.x509.subject}") did not actually sign the certificate below it`;
        continue;
      }
      next = candidate;
      break;
    }

    if (!next) {
      return {
        ok: false,
        reason: failure || "no certification path to a trusted root could be built",
      };
    }
    used.add(next.der.toString("base64"));
    chain.push(next.x509);
    current = next;
  }

  return { ok: false, reason: "certification path exceeded the maximum depth" };
}
