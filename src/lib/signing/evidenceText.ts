/**
 * The words of the evidence pack — the README a third party reads first.
 *
 * No server imports, so what the pack SAYS can be tested without a database:
 * this is the page that gets read in a dispute, by somebody who has never seen
 * the CRM.
 */

export type EvidenceSigner = {
  name: string;
  role: string;
  status: string;
  signedAt: string | null;
  ip: string | null;
  identityMethod: string | null;
  identityVerifiedAt: string | null;
  /** Who watched an in-person signature, when the signed event names them. */
  witness: string | null;
  /** The consent wording recorded with the signature, when it was recorded. */
  consent: string | null;
  declineReason: string | null;
};

export type EvidenceEvent = {
  at: string;
  type: string;
  actor: string;
  channel: string | null;
  ip: string | null;
  /** Whether a send was accepted, when the event recorded it. */
  delivered: boolean | null;
};

export type EvidenceReadme = {
  title: string;
  reference: string;
  workspace: string;
  preparedAt: string;
  preparedBy: string;
  timeZone: string;
  sha256: string | null;
  /** The file in the pack is the file that was sealed: its hash was recomputed and compared. */
  fileMatches: boolean;
  sizeBytes: number;
  sealedAt: string | null;
  /** `trusted`: issued by a public authority a PDF reader recognises, not the company's own. */
  certificate: { subject: string; fingerprint: string; trusted: boolean } | null;
  timestamp: { authority: string | null; at: string | null; verified: boolean } | null;
  check: { at: string; valid: boolean; errors: string[] } | null;
  hasAuditFile: boolean;
  signers: EvidenceSigner[];
  events: EvidenceEvent[];
};

/**
 * What a signer proved about who they are — the same claims, no stronger, that
 * the certificate inside the PDF makes (complete.ts). "Link" is possession of
 * the link and is said as that.
 */
export function identityInWords(signer: Pick<EvidenceSigner, "identityMethod" | "identityVerifiedAt" | "witness">): string {
  const at = signer.identityVerifiedAt ? ` (${signer.identityVerifiedAt})` : "";
  if (signer.identityMethod === "email_otp") return `Identity checked by a one-time code sent to the email address on file${at}`;
  if (signer.identityMethod === "sms_otp") return `Identity checked by a one-time code sent to the mobile number on file${at}`;
  if (signer.identityMethod === "in_person") return `Signed in person${signer.witness ? `, in the presence of ${signer.witness}` : ", in the presence of a member of staff"}`;
  if (signer.identityMethod === "staff_session") return "Signed by a member of staff while signed in to their own account";
  return "Opened with the unique signing link sent to this person. No further identity check was asked for";
}

/** `sent`, `field_filled` → words. Unknown types are shown as recorded, never dropped. */
export function eventInWords(type: string): string {
  const known: Record<string, string> = {
    created: "Request created",
    sent: "Sent",
    reminded: "Reminder sent",
    opened: "Opened",
    identity_challenge_sent: "One-time code sent",
    identity_verified: "One-time code accepted",
    field_filled: "Field completed",
    signed: "Signed",
    declined: "Declined",
    approval_requested: "Approval asked for",
    approval_sent: "Approver emailed",
    approved: "Approved",
    rejected: "Rejected",
    voided: "Withdrawn",
    expired: "Link expired",
    completed: "Completed, and everyone sent their copy",
    post_completion: "Record marked as signed",
    completion_blocked: "Could not complete: the record had changed",
    recovery_attempt: "Sending the signed copies was tried again",
    stale_claim_recovered: "An interrupted send was tidied up",
    signed_copy_requested: "Signed copy sent again at the signer's request",
  };
  return known[type] ?? type.replace(/_/g, " ");
}

/** The pack's file names, shared with the code that builds the archive so the README cannot describe a file that is not there. */
export const SIGNED_FILE = "Signed document.pdf";
export const AUDIT_FILE = "audit-trail.json";
/** The stored value is the time-stamp TOKEN, not the authority's whole reply — hence `-token_in` below. */
export const TIMESTAMP_FILE = "timestamp-token.tst";

/** A section heading, as lines — never an embedded newline, so the whole page has one kind of line ending. */
const rule = (title: string) => ["", title, "-".repeat(title.length), ""];

export function evidenceReadme(pack: EvidenceReadme): string {
  const lines: string[] = [];
  lines.push("EVIDENCE PACK", pack.title, "");
  lines.push(`Prepared ${pack.preparedAt} by ${pack.preparedBy}, ${pack.workspace}.`);
  lines.push(`All times are ${pack.timeZone} time.`);

  lines.push(...rule("What is in this pack"));
  lines.push(SIGNED_FILE);
  lines.push("    The signed original, exactly as it was sealed. Its last page is a certificate");
  lines.push("    naming everyone who signed.");
  if (pack.hasAuditFile) {
    lines.push(AUDIT_FILE);
    lines.push("    The full record behind this page, for a technical examiner: every signer,");
    lines.push("    every field, and every event with the hash that chains it to the one before.");
  }
  if (pack.timestamp) {
    lines.push(TIMESTAMP_FILE);
    lines.push("    A time-stamp issued by an independent authority when the document was sealed.");
  }
  lines.push("README.txt");
  lines.push("    This page.");

  lines.push(...rule("The document"));
  lines.push(`Reference      ${pack.reference}`);
  lines.push(`Sealed         ${pack.sealedAt ?? "not recorded"}`);
  lines.push(`Size           ${pack.sizeBytes.toLocaleString("en-GB")} bytes`);
  lines.push(`SHA-256        ${pack.sha256 ?? "not recorded"}`);
  if (pack.certificate) {
    lines.push(`Sealed with    ${pack.certificate.subject}`);
    lines.push(`               certificate fingerprint (SHA-256) ${pack.certificate.fingerprint}`);
  }
  if (pack.timestamp) {
    lines.push(`Time-stamp     ${pack.timestamp.at ?? "time not recorded"}${pack.timestamp.authority ? `, from ${pack.timestamp.authority}` : ""}`);
    lines.push(`               ${pack.timestamp.verified ? "checked again when this pack was made: it is genuine and covers this document" : "COULD NOT BE VERIFIED when this pack was made"}`);
  } else {
    lines.push("Time-stamp     none. The independent time-stamp service did not answer when this was sealed.");
  }
  lines.push("");
  lines.push(
    pack.fileMatches
      ? "The file in this pack was compared with the SHA-256 recorded when it was sealed. They match: it has not changed."
      : "WARNING: the file in this pack does NOT match the SHA-256 recorded when it was sealed. Do not rely on it.",
  );
  if (pack.check) {
    lines.push(
      pack.check.valid
        ? `The stored record was last checked on ${pack.check.at}: file, seal and audit trail all verified.`
        : `The stored record was last checked on ${pack.check.at} and FAILED: ${pack.check.errors.join("; ")}.`,
    );
  }

  lines.push(...rule("Who signed"));
  for (const signer of pack.signers) {
    lines.push(`${signer.name} (${signer.role})`);
    if (signer.status === "signed") {
      lines.push(`    Signed ${signer.signedAt ?? "—"}${signer.ip ? `, from IP address ${signer.ip}` : ""}`);
      lines.push(`    ${identityInWords(signer)}.`);
      if (signer.consent) lines.push(`    Agreed to: "${signer.consent}"`);
    } else if (signer.status === "declined") {
      lines.push(`    Declined${signer.declineReason ? `. Their reason: "${signer.declineReason}"` : ". No reason given."}`);
    } else {
      lines.push("    Did not sign.");
    }
  }

  lines.push(...rule("What happened, in order"));
  for (const event of pack.events) {
    const via = event.channel ? ` by ${event.channel.replace(/_/g, " ")}` : "";
    const outcome = event.delivered === null ? "" : event.delivered ? " (accepted)" : " (FAILED)";
    lines.push(`${event.at}   ${eventInWords(event.type)}${via}${outcome} — ${event.actor}${event.ip ? ` — IP ${event.ip}` : ""}`);
  }

  lines.push(...rule("How to check this yourself"));
  lines.push("1. The file has not changed.");
  lines.push(`   Work out the SHA-256 of "${SIGNED_FILE}" and compare it with the value above.`);
  lines.push(`     Windows:      certutil -hashfile "${SIGNED_FILE}" SHA256`);
  lines.push(`     Mac or Linux: shasum -a 256 "${SIGNED_FILE}"`);
  lines.push("   Changing a single character of the document gives a completely different value.");
  lines.push("");
  lines.push("2. The seal.");
  lines.push("   Open the PDF in Adobe Acrobat Reader and open the Signatures panel. It reports whether");
  lines.push("   the document has been modified since the seal was applied.");
  if (pack.certificate && !pack.certificate.trusted) {
    lines.push("   It will also say the signer's identity is unknown: the certificate that sealed it was");
    lines.push("   not issued by a public authority. The fingerprint above identifies that certificate.");
  }
  if (pack.timestamp) {
    lines.push("");
    lines.push("3. The time.");
    lines.push(`   ${TIMESTAMP_FILE} is a standard RFC 3161 time-stamp token over the SHA-256 above.`);
    lines.push(`     openssl ts -reply -in ${TIMESTAMP_FILE} -token_in -text`);
    lines.push("   shows the time the authority attested and the hash it covers.");
  }
  if (pack.hasAuditFile) {
    lines.push("");
    lines.push(`${pack.timestamp ? "4" : "3"}. The audit trail.`);
    lines.push(`   Each event in ${AUDIT_FILE} carries prevHash (the eventHash of the event before it)`);
    lines.push("   and its own eventHash. Removing, adding or altering any event breaks every hash after it.");
  }
  lines.push("");
  lines.push("This pack describes what was recorded. It is not legal advice.");
  return lines.join("\r\n") + "\r\n";
}
