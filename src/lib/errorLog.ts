import { basePrisma } from "./db";
import { redactUrl } from "./redactUrl";
import { actingTenantId } from "./actingTenant";

/**
 * Best-effort owning tenant for an error.
 *
 * ErrorLog is a GLOBAL model (see GLOBAL_MODELS in ./tenantGuard for the decision
 * and what it costs): this column is ATTRIBUTION, so that per-tenant error health
 * and the per-tenant first-error alert throttle have something to key on. A null is
 * a correct outcome here, not a missed stamp — an error raised before any tenant is
 * known belongs to nobody, and inventing an owner would make a healthy workspace
 * look broken.
 *
 * The resolution order is the shared one ({@link actingTenantId}): an established
 * scope, `system` and platform-console requests deliberately unattributed, then the
 * acting staff session. Shared rather than restated so error attribution and record
 * ownership cannot drift apart — this file used to carry its own copy, and a copy
 * is a thing that goes stale silently. Anything that throws is swallowed:
 * attribution must never be able to break logging.
 */
async function tenantForError(): Promise<string | null> {
  try {
    return await actingTenantId();
  } catch {
    return null;
  }
}

/**
 * Files a system error where it can actually be seen (Settings → System Log)
 * instead of evaporating with the serverless function. Never throws. A push
 * fires at most once per 30 minutes PER TENANT so a crash-loop can't melt your
 * phone — and so one tenant's error storm cannot silence another tenant's alert.
 */
export type LogErrorOptions = {
  /**
   * Attribute to this tenant instead of inferring one. For a caller that KNOWS
   * the owner — an inbound webhook, which has no staff session to fall back to.
   */
  tenantId?: string | null;
  /**
   * Whether this may raise the first-error push. Default true. Set false for an
   * EXPECTED, self-healing condition: a lease contention is the system working,
   * and while enforcement is dormant `sendPushToAll` has no scope to narrow to,
   * so it would notify every subscription on the install.
   */
  alert?: boolean;
};

export async function logError(
  scope: string,
  err: unknown,
  context?: string,
  options?: LogErrorOptions,
): Promise<void> {
  try {
    // EVERY string that lands in ErrorLog goes through redactUrl first. The
    // System Log is rendered to workspace owners and to platform admins, and a
    // /signing, /approvals, /s or /api/track URL is a working credential — so it
    // must be stripped at the write, not at each of the ~25 logError call sites.
    // Message and stack are swept too: a failing fetch or a Prisma error commonly
    // quotes the URL it was handed.
    const raw =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    const message = redactUrl(raw);
    const stack = err instanceof Error && err.stack ? redactUrl(err.stack).slice(0, 4000) : undefined;
    const tenantId = options?.tenantId !== undefined ? options.tenantId : await tenantForError();

    await basePrisma.errorLog.create({
      data: {
        scope,
        message: message.slice(0, 1000),
        stack,
        context: context ? redactUrl(context).slice(0, 1000) : context,
        tenantId,
      },
    });

    // Throttle PER TENANT. Counting globally meant a noisy tenant suppressed the
    // first-error alert for every other tenant — the alert would simply never
    // fire for them, silently. Unattributed errors (tenantId null) throttle as
    // their own bucket rather than joining an arbitrary tenant's.
    if (options?.alert === false) return;
    const recent = await basePrisma.errorLog.count({
      where: {
        createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        tenantId,
      },
    });
    if (recent === 1) {
      const { sendPushToAll } = await import("./push");
      await sendPushToAll(
        {
          title: "⚠ System error",
          body: `${scope}: ${message.slice(0, 90)}`,
          url: "/settings?tab=system",
        },
        "system_error"
      ).catch(() => {});
    }
  } catch {
    // the error logger must never become the error
  }
}
