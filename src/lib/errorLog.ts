import { basePrisma } from "./db";
import { currentTenantScope } from "./tenantScope";

/**
 * Best-effort owning tenant for an error.
 *
 * A `system` scope means trusted cross-tenant work (backups, some cron) — that is
 * genuinely not one tenant's error, so it stays null rather than being attributed
 * to whichever tenant happened to be in scope. Anything that throws here is
 * swallowed: attribution must never be able to break logging.
 */
async function tenantForError(): Promise<string | null> {
  try {
    const scope = currentTenantScope();
    // A `system` scope is trusted cross-tenant work (backups, some cron). That is
    // genuinely not one tenant's error, so it stays unattributed rather than being
    // blamed on whichever tenant happened to be in scope.
    if (scope?.system) return null;
    if (scope?.tenantId) return scope.tenantId;
  } catch {
    /* fall through to the session */
  }

  // No scope. This is the NORMAL case while tenant enforcement is dormant: the
  // scope helpers deliberately no-op when `tenantEnforcing()` is false, so without
  // this fallback EVERY error would be unattributed until enforcement ships, and
  // per-tenant error health would be permanently empty.
  //
  // Fall back to the acting staff session's tenant. Errors raised outside a request
  // (cron, webhooks, build) have no cookies to read, which throws — that is exactly
  // the unattributed case, so it resolves to null.
  try {
    const { getActiveTenantId } = await import("./auth");
    return await getActiveTenantId();
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
export async function logError(
  scope: string,
  err: unknown,
  context?: string
): Promise<void> {
  try {
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    const stack = err instanceof Error ? err.stack?.slice(0, 4000) : undefined;
    const tenantId = await tenantForError();

    await basePrisma.errorLog.create({
      data: {
        scope,
        message: message.slice(0, 1000),
        stack,
        context: context?.slice(0, 1000),
        tenantId,
      },
    });

    // Throttle PER TENANT. Counting globally meant a noisy tenant suppressed the
    // first-error alert for every other tenant — the alert would simply never
    // fire for them, silently. Unattributed errors (tenantId null) throttle as
    // their own bucket rather than joining an arbitrary tenant's.
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
