import { basePrisma } from "./db";

/**
 * Files a system error where it can actually be seen (Settings → System Log)
 * instead of evaporating with the serverless function. Never throws. A push
 * fires at most once per 30 minutes so a crash-loop can't melt your phone.
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
    await basePrisma.errorLog.create({
      data: { scope, message: message.slice(0, 1000), stack, context: context?.slice(0, 1000) },
    });

    const recent = await basePrisma.errorLog.count({
      where: { createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } },
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
