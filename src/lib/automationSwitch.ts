import "server-only";
import { basePrisma } from "./db";
import { getSetting } from "./settings";
import { automationDefault } from "./automationRegister";

/**
 * Is this automation switched on for the workspace? Its switch is shown, with
 * everything else that runs by itself, on Settings → Automatic jobs & messages
 * (automationRegister.ts). Unset → the register's default (OFF for anything
 * that reaches a customer, unless the owner chose otherwise).
 *
 * `tenantId` for background work that knows its workspace but runs without a
 * staff scope (the signing job worker); otherwise the acting workspace.
 *
 * A setting that can't be read: an OFF-by-default send stays off (never message
 * a customer on a guess); an ON-by-default one throws, so the job retries
 * instead of silently dropping something the owner wants sent.
 */
export async function automationOn(key: string, tenantId?: string | null): Promise<boolean> {
  const fallback = automationDefault(key);
  try {
    const raw = tenantId
      ? (await basePrisma.appSetting.findUnique({ where: { tenantId_key: { tenantId, key } }, select: { value: true } }))?.value ?? null
      : await getSetting(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  } catch (error) {
    if (fallback) throw error;
    return false;
  }
}
