import { basePrisma } from "./db";
import { redactUrl } from "./redactUrl";
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
  // a fallback EVERY error would be unattributed until enforcement ships, and
  // per-tenant error health would be permanently empty.
  //
  // But the fallback must NOT fire on a PLATFORM request. The CRM session cookie is
  // scoped to "/", so it is sent to /platform too — meaning a platform admin who
  // also happens to be signed into the CRM would have platform-global failures
  // blamed on whichever tenant their CRM account belongs to. That is a wrong
  // attribution, not a missing one, which is worse: it makes a healthy tenant look
  // broken. A platform request is identified by its own cookie, which the CRM never
  // sets.
  try {
    const { cookies } = await import("next/headers");
    const { PLATFORM_SESSION_COOKIE } = await import("./platformSession");
    const store = await cookies();
    if (store.get(PLATFORM_SESSION_COOKIE)) return null;
  } catch {
    // No request context at all (cron, build) — nothing to attribute to anyway.
    return null;
  }

  // A genuine CRM request: attribute to the acting staff session's tenant.
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
    const tenantId = await tenantForError();

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
