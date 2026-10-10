import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { formatDateTime, type Regional } from "@/lib/format";
import { zipStore, type ZipEntry } from "@/lib/zip";
import { verifyTimestampToken } from "./timestampVerify";
import { AUDIT_FILE, SIGNED_FILE, TIMESTAMP_FILE, evidenceReadme, type EvidenceEvent, type EvidenceSigner } from "./evidenceText";

/**
 * What can be shown — and handed over — to prove a completed document is what
 * was signed.
 *
 * Every fact here was already being recorded: the sealed file's hash, the
 * certificate that sealed it, an independent time-stamp, a hash-chained audit
 * trail, and a check after sealing that the stored file matches all of them.
 * None of it was visible anywhere, so the only way to answer "can you prove it?"
 * was to read database rows.
 *
 * Read through the guarded client: everything is scoped to the acting workspace.
 */

export type EvidenceCertificate = {
  /** The certificate's own name (its CN), for a person to read. */
  name: string;
  subject: string;
  fingerprint: string;
  /** Issued by an authority a PDF reader recognises — not the company's own. */
  trusted: boolean;
};

export type Evidence = {
  sha256: string | null;
  sealedAt: Date | null;
  retainUntil: Date | null;
  certificate: EvidenceCertificate | null;
  /** The latest check of the stored file, its seal and the audit trail. Null until the first one has run. */
  check: { at: Date; valid: boolean; errors: string[]; chainLength: number | null; chainVerified: boolean | null } | null;
  /** Null when no independent time-stamp was obtained at sealing. */
  timestamp: { authority: string | null; at: Date | null; verified: boolean } | null;
};

type EvidenceRequest = {
  id: string;
  signedPdfHash: string | null;
  completedAt: Date | null;
  timestampToken: string | null;
  timestampedAt: Date | null;
  timestampAuthority: string | null;
};

function certificateFrom(manifest: unknown): EvidenceCertificate | null {
  const cert = (manifest as { certificate?: Record<string, unknown> } | null)?.certificate;
  if (!cert || typeof cert.subject !== "string" || typeof cert.fingerprintSha256 !== "string") return null;
  return {
    name: /(?:^|,\s*)CN=([^,]+)/.exec(cert.subject)?.[1]?.trim() || cert.subject,
    subject: cert.subject,
    fingerprint: cert.fingerprintSha256,
    trusted: cert.trusted === true,
  };
}

/** The stored evidence manifest, once the check that follows sealing has produced one. */
async function latestValidation(requestId: string) {
  const artifact = await prisma.legalArtifact.findFirst({
    where: { requestId },
    select: { id: true, sha256: true, retainUntil: true },
  });
  if (!artifact) return { artifact: null, validation: null };
  const validation = await prisma.legalArtifactValidation.findFirst({
    where: { artifactId: artifact.id },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, valid: true, errors: true, manifest: true },
  });
  return { artifact, validation };
}

export async function loadEvidence(req: EvidenceRequest): Promise<Evidence> {
  const { artifact, validation } = await latestValidation(req.id);
  const sha256 = artifact?.sha256 ?? req.signedPdfHash;
  const chain = (validation?.manifest as { evidence?: { chainLength?: unknown; chainVerified?: unknown } } | null)?.evidence;

  // Re-verified NOW, not read from the column: "verified" on this page has to
  // mean the token really is genuine and really covers this document's hash.
  const stamp =
    req.timestampToken && sha256 && /^[0-9a-f]{64}$/i.test(sha256)
      ? verifyTimestampToken(req.timestampToken, Buffer.from(sha256, "hex"))
      : null;

  return {
    sha256,
    sealedAt: req.completedAt,
    retainUntil: artifact?.retainUntil ?? null,
    certificate: certificateFrom(validation?.manifest),
    check: validation
      ? {
          at: validation.createdAt,
          valid: validation.valid,
          errors: Array.isArray(validation.errors) ? validation.errors.map(String) : [],
          chainLength: typeof chain?.chainLength === "number" ? chain.chainLength : null,
          chainVerified: typeof chain?.chainVerified === "boolean" ? chain.chainVerified : null,
        }
      : null,
    timestamp: req.timestampToken
      ? { authority: req.timestampAuthority, at: stamp?.ok ? stamp.genTime : req.timestampedAt, verified: Boolean(stamp?.ok) }
      : null,
  };
}

type PackRecipient = {
  id: string;
  name: string;
  role: string;
  status: string;
  signedAt: Date | null;
  signedName: string | null;
  signerIp: string | null;
  identityMethod: string | null;
  identityVerifiedAt: Date | null;
  declineReason: string | null;
};

type PackEvent = {
  type: string;
  actor: string;
  channel: string | null;
  ip: string | null;
  recipientId: string | null;
  metadata: unknown;
  createdAt: Date;
};

export type EvidencePackInput = EvidenceRequest & {
  title: string;
  tenantId: string | null;
  signedPdfRef: string;
  recipients: PackRecipient[];
  /** In chain order. */
  events: PackEvent[];
};

/** What each signer's own `signed` event recorded beside the signature. */
function signedFacts(events: PackEvent[]): Map<string, { witness: string | null; consent: string | null }> {
  const out = new Map<string, { witness: string | null; consent: string | null }>();
  for (const event of events) {
    if (event.type !== "signed" || !event.recipientId || !event.metadata || typeof event.metadata !== "object") continue;
    const meta = event.metadata as { witness?: { name?: unknown }; consent?: { text?: unknown } };
    out.set(event.recipientId, {
      witness: typeof meta.witness?.name === "string" ? meta.witness.name : null,
      consent: typeof meta.consent?.text === "string" ? meta.consent.text : null,
    });
  }
  return out;
}

/**
 * One download holding the sealed original and everything needed to check it
 * without this system: the audit trail, the time-stamp token, and a plain-language
 * page saying what each file is and how to verify it.
 *
 * The PDF in the pack is re-hashed as it is packed, and the README says whether
 * it still matches what was recorded at sealing — a pack that silently carried
 * an altered file would be worse than no pack.
 */
export async function buildEvidencePack(
  req: EvidencePackInput,
  by: { name: string; workspace: string; regional: Regional },
): Promise<Buffer> {
  const pdf = await readFile(req.signedPdfRef, req.tenantId);
  const evidence = await loadEvidence(req);
  const { validation } = await latestValidation(req.id);
  const when = (date: Date | null | undefined) => (date ? formatDateTime(date, by.regional) : null);
  const facts = signedFacts(req.events);
  const now = new Date();

  const signers: EvidenceSigner[] = req.recipients
    .filter((recipient) => recipient.role !== "viewer")
    .map((recipient) => ({
      name: recipient.signedName || recipient.name,
      role: recipient.role,
      status: recipient.status,
      signedAt: when(recipient.signedAt),
      ip: recipient.signerIp,
      identityMethod: recipient.identityMethod,
      identityVerifiedAt: when(recipient.identityVerifiedAt),
      witness: facts.get(recipient.id)?.witness ?? null,
      consent: facts.get(recipient.id)?.consent ?? null,
      declineReason: recipient.declineReason?.trim() || null,
    }));

  const events: EvidenceEvent[] = req.events.map((event) => {
    const ok = (event.metadata as { ok?: unknown } | null)?.ok;
    return {
      at: formatDateTime(event.createdAt, by.regional),
      type: event.type,
      actor: event.actor,
      channel: event.channel,
      ip: event.ip,
      delivered: (event.type === "sent" || event.type === "reminded") && typeof ok === "boolean" ? ok : null,
    };
  });

  const readme = evidenceReadme({
    title: req.title,
    reference: req.id,
    workspace: by.workspace,
    preparedAt: formatDateTime(now, by.regional),
    preparedBy: by.name,
    timeZone: by.regional.timeZone,
    sha256: evidence.sha256,
    fileMatches: Boolean(evidence.sha256) && crypto.createHash("sha256").update(pdf).digest("hex") === evidence.sha256,
    sizeBytes: pdf.length,
    sealedAt: when(evidence.sealedAt),
    certificate: evidence.certificate
      ? { subject: evidence.certificate.subject, fingerprint: evidence.certificate.fingerprint, trusted: evidence.certificate.trusted }
      : null,
    timestamp: evidence.timestamp
      ? { authority: evidence.timestamp.authority, at: when(evidence.timestamp.at), verified: evidence.timestamp.verified }
      : null,
    check: evidence.check ? { at: formatDateTime(evidence.check.at, by.regional), valid: evidence.check.valid, errors: evidence.check.errors } : null,
    hasAuditFile: Boolean(validation),
    signers,
    events,
  });

  const files: ZipEntry[] = [
    { name: "README.txt", data: Buffer.from(readme, "utf8"), modified: now },
    { name: SIGNED_FILE, data: pdf, modified: req.completedAt ?? now },
  ];
  if (validation) files.push({ name: AUDIT_FILE, data: Buffer.from(JSON.stringify(validation.manifest, null, 2), "utf8"), modified: validation.createdAt });
  if (req.timestampToken) files.push({ name: TIMESTAMP_FILE, data: Buffer.from(req.timestampToken, "base64"), modified: req.timestampedAt ?? now });
  return zipStore(files);
}
