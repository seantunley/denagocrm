/**
 * Recording that a photo upload failed, when the reason the upload failed is
 * also the reason the recording cannot be done the usual way.
 *
 * Deliberately NOT in the "use server" action module, and every effect is
 * injected. The whole point of this code is what happens when its dependencies
 * THROW, and a version that could only be checked by reading it in source order
 * is exactly what let the previous two attempts ship still broken.
 */

export type PhotoFailureTarget = {
  kind: "delivery" | "jobcard" | "jobcard-checkout" | "inspection";
  recordId: string;
  jobCardId?: string;
};

export type PhotoFailureDetail = {
  stage: "prepare" | "transfer" | "finalize";
  fileType?: string;
  fileSize?: number;
  reason?: string;
};

export type PhotoFailureDeps = {
  /** Establishes WHO is asking. Must not require a workspace. */
  identify: () => Promise<{ id: string } | null>;
  /** The acting workspace. THROWS when the sign-in resolves none. */
  resolveTenant: () => Promise<string>;
  /**
   * Record-level authorisation. Also throws when no workspace resolves, because
   * it re-enters the same tenant lookup — which is the whole problem here.
   */
  authorise: (target: PhotoFailureTarget, tenantId: string | null) => Promise<boolean>;
  log: (entry: { message: string; context: string; tenantId: string | null }) => Promise<void>;
};

export type PhotoFailureOutcome = {
  logged: boolean;
  tenantId: string | null;
  /** null when authorisation could not be COMPLETED, as opposed to refused. */
  authorised: boolean | null;
};

/** One line, length-capped: client text on its way into a log row. */
export function sanitiseReason(reason: string | undefined): string {
  return (reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Write one log row about a failed upload, and do it even when the workspace
 * cannot be resolved.
 *
 * THE ORDER MATTERS AND IS THE FIX. The previous version resolved the tenant,
 * then called requireQuoteAccess/requireJobCardAccess, then logged. Both of the
 * first two go through the same tenant resolution, so when a sign-in resolved no
 * workspace — the headline case, and the one a Server Action hits because it does
 * not inherit the page's scope — the gate threw before the log was ever reached.
 * The System Log stayed empty in precisely the scenario the report exists for.
 *
 * Identity is the only hard requirement, because identity is the only thing that
 * stops this being a way to write arbitrary rows and it is the only one
 * obtainable without a workspace. Authorisation is still attempted and its
 * VERDICT is recorded; when it cannot complete, the row says so rather than
 * being dropped. A row that says "authorised=unknown" is worth incomparably more
 * than no row at all, which is what a person staring at an empty log had.
 */
export async function recordPhotoUploadFailure(
  deps: PhotoFailureDeps,
  target: PhotoFailureTarget,
  detail: PhotoFailureDetail,
): Promise<PhotoFailureOutcome> {
  const user = await deps.identify();
  // No identity is the one case that writes nothing. Everything past here is a
  // signed-in person reporting a failure on their own screen.
  if (!user) return { logged: false, tenantId: null, authorised: null };

  let tenantId: string | null = null;
  try {
    tenantId = await deps.resolveTenant();
  } catch {
    tenantId = null;
  }

  let authorised: boolean | null = null;
  try {
    authorised = await deps.authorise(target, tenantId);
  } catch {
    // Could not COMPLETE the check — almost certainly the same missing workspace
    // that failed above. Recorded as unknown, not as a refusal, because those are
    // different facts and the difference is what someone reading the log needs.
    authorised = null;
  }

  // A REFUSAL is the one verdict that suppresses the row: the caller has no
  // business with this record, so their claim about it is not evidence.
  if (authorised === false) return { logged: false, tenantId, authorised };

  const reason = sanitiseReason(detail.reason);
  await deps.log({
    message: reason
      ? `A photo did not reach blob storage: ${reason}`
      : "A photo did not reach blob storage (the browser reported no reason).",
    context:
      `kind=${target.kind} record=${target.recordId} stage=${detail.stage} ` +
      `type=${detail.fileType ?? "unknown"} bytes=${detail.fileSize ?? 0} ` +
      `source=browser user=${user.id} authorised=${authorised === null ? "unknown" : "yes"}` +
      `${tenantId ? "" : " workspace=unresolved"}`,
    tenantId,
  });
  return { logged: true, tenantId, authorised };
}
