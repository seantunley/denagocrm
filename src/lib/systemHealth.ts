import "server-only";
import { list } from "@vercel/blob";
import { getSetting, putSetting } from "./settings";
import { sendPushToAll } from "./push";
import { logError } from "./errorLog";

/* ── AI usage ledger (our own token counter, month by month) ─────── */

const monthKey = () => {
  const d = new Date();
  return `AI_TOKENS_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/** Called after every Anthropic response — cheap best-effort counter. */
export async function recordAiUsage(usage?: { input_tokens?: number; output_tokens?: number }) {
  if (!usage) return;
  try {
    const cur = JSON.parse((await getSetting(monthKey())) ?? '{"in":0,"out":0,"calls":0}');
    cur.in += usage.input_tokens ?? 0;
    cur.out += usage.output_tokens ?? 0;
    cur.calls += 1;
    await putSetting(monthKey(), JSON.stringify(cur));
  } catch {
    /* never break the caller over accounting */
  }
}

export async function getAiUsageThisMonth(): Promise<{ in: number; out: number; calls: number }> {
  try {
    return JSON.parse((await getSetting(monthKey())) ?? '{"in":0,"out":0,"calls":0}');
  } catch {
    return { in: 0, out: 0, calls: 0 };
  }
}

/* ── AI health ping (billing problems surface BEFORE the bot dies) ─ */

export type AiHealth = {
  status: "ok" | "billing" | "auth" | "error" | "unconfigured";
  detail: string;
  at: string;
};

export async function getAiHealth(): Promise<AiHealth | null> {
  try {
    const raw = await getSetting("AI_HEALTH");
    return raw ? (JSON.parse(raw) as AiHealth) : null;
  } catch {
    return null;
  }
}

/** Hourly minimal ping; alerts the security recipients on ok→broken. */
export async function runAiHealthIfDue(): Promise<void> {
  const prev = await getAiHealth();
  if (prev && Date.now() - new Date(prev.at).getTime() < 55 * 60 * 1000) return; // hourly

  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  let next: AiHealth;
  if (!apiKey) {
    next = { status: "unconfigured", detail: "No Anthropic API key set.", at: new Date().toISOString() };
  } else {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.ok) {
        next = { status: "ok", detail: "AI responding normally.", at: new Date().toISOString() };
      } else {
        const text = (await res.text().catch(() => "")).slice(0, 300);
        const billing = res.status === 400 && /credit|billing|balance/i.test(text);
        next = {
          status: billing ? "billing" : res.status === 401 ? "auth" : "error",
          detail: billing
            ? "Anthropic reports the credit balance is too low — top up before the bot goes silent."
            : `Anthropic API returned ${res.status}.`,
          at: new Date().toISOString(),
        };
      }
    } catch (e) {
      next = {
        status: "error",
        detail: e instanceof Error ? e.message : "AI unreachable.",
        at: new Date().toISOString(),
      };
    }
  }

  await putSetting("AI_HEALTH", JSON.stringify(next));

  // Alert once on the transition into a broken state
  const wasOk = !prev || prev.status === "ok" || prev.status === "unconfigured";
  const isBroken = next.status === "billing" || next.status === "auth" || next.status === "error";
  if (wasOk && isBroken) {
    await logError("ai-health", `AI health degraded: ${next.status} — ${next.detail}`);
    await sendPushToAll(
      { title: "⚠️ AI assistant problem", body: next.detail.slice(0, 120), url: "/settings/security" },
      "security"
    ).catch(() => {});
  }
}

/* ── Backup watchdog (daily backup missed → alert, throttled) ────── */

export async function runBackupWatchdog(): Promise<void> {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return;
    const { blobs } = await list({ prefix: "backups/database/" });
    const newest = blobs.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    )[0];
    const ageH = newest ? (Date.now() - new Date(newest.uploadedAt).getTime()) / 36e5 : Infinity;
    if (ageH <= 26) return; // fresh — nothing to do

    const lastAlert = await getSetting("BACKUP_ALERT_AT");
    if (lastAlert && Date.now() - new Date(lastAlert).getTime() < 20 * 60 * 60 * 1000) return;

    await putSetting("BACKUP_ALERT_AT", new Date().toISOString());
    const msg = newest
      ? `Last backup is ${Math.round(ageH)} hours old — the nightly job may be failing.`
      : "No backups found in storage at all.";
    await logError("backup-watchdog", msg);
    await sendPushToAll(
      { title: "🛑 Backup problem", body: msg, url: "/settings/security" },
      "backup"
    ).catch(() => {});
  } catch (e) {
    await logError("backup-watchdog", e);
  }
}
