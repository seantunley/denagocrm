import "server-only";
import { list } from "@vercel/blob";
import { prisma, basePrisma } from "./db";
import { getSetting, putSetting, encryptValue, decryptValue } from "./settings";

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckResult = {
  id: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
};
export type RunbookRun = {
  ranAt: string;
  score: number; // % of checks passing
  passed: number;
  warned: number;
  failed: number;
  results: CheckResult[];
};

const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
  (process.env.NODE_ENV === "production" ? "https://crm.denagocpt.co.za" : "http://localhost:3000")
).replace(/\/$/, "");

/** Keys that must never sit in the DB as clear text. */
const SECRET_KEYS = [
  "WA_ACCESS_TOKEN",
  "META_APP_SECRET",
  "META_VERIFY_TOKEN",
  "INTAKE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "SMTP_PASS",
  "META_PAGE_ACCESS_TOKEN",
];

async function probe(path: string, init?: RequestInit): Promise<number> {
  try {
    const res = await fetch(`${APP_URL}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  } catch {
    return -1;
  }
}

/** Run every automated security check. ~seconds; safe to call any time. */
export async function runSecurityChecks(): Promise<RunbookRun> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);

  /* ── Keys & secrets ─────────────────────────────────────────── */
  try {
    const ok = decryptValue(encryptValue("runbook-ping")) === "runbook-ping";
    add({
      id: "enc-key",
      group: "Keys & secrets",
      label: "Encryption key valid",
      status: ok ? "pass" : "fail",
      detail: ok ? "AES-256-GCM round-trip succeeded." : "Round-trip failed.",
      fix: ok ? undefined : "Check SETTINGS_ENCRYPTION_KEY (64 hex chars) in the environment.",
    });
  } catch (e) {
    add({
      id: "enc-key",
      group: "Keys & secrets",
      label: "Encryption key valid",
      status: "fail",
      detail: e instanceof Error ? e.message : "Encryption unavailable.",
      fix: "Set SETTINGS_ENCRYPTION_KEY (64 hex chars) in the environment.",
    });
  }

  const sessionSecret = process.env.SESSION_SECRET ?? "";
  add({
    id: "session-secret",
    group: "Keys & secrets",
    label: "Session signing secret",
    status: sessionSecret.length >= 32 ? "pass" : "fail",
    detail:
      sessionSecret.length >= 32
        ? "SESSION_SECRET is set and strong."
        : "SESSION_SECRET missing or under 32 characters.",
    fix: sessionSecret.length >= 32 ? undefined : "Set a long random SESSION_SECRET env var.",
  });

  add({
    id: "cron-secret",
    group: "Keys & secrets",
    label: "Cron authentication",
    status: process.env.CRON_SECRET ? "pass" : "warn",
    detail: process.env.CRON_SECRET
      ? "CRON_SECRET is set — scheduled jobs authenticate with a dedicated secret."
      : "CRON_SECRET not set — cron rides on the intake API key.",
    fix: process.env.CRON_SECRET ? undefined : "Add a CRON_SECRET env var in Vercel.",
  });

  const rows = await basePrisma.appSetting.findMany({
    where: { key: { in: SECRET_KEYS } },
    select: { key: true, value: true },
  });
  const clearText = rows.filter((r) => r.value && !r.value.startsWith("enc:v1:"));
  add({
    id: "secrets-encrypted",
    group: "Keys & secrets",
    label: "Stored credentials encrypted",
    status: clearText.length === 0 ? "pass" : "fail",
    detail:
      clearText.length === 0
        ? `${rows.length} stored credential(s), all encrypted at the application layer.`
        : `Clear-text credential(s): ${clearText.map((r) => r.key).join(", ")}.`,
    fix: clearText.length ? "Re-save those credentials in Settings to re-encrypt them." : undefined,
  });

  /* ── Surface exposure (live probes) ─────────────────────────── */
  const surface: { id: string; label: string; path: string; init?: RequestInit }[] = [
    { id: "wh-whatsapp", label: "WhatsApp webhook rejects unsigned calls", path: "/api/webhooks/whatsapp", init: { method: "POST", body: "{}" } },
    { id: "wh-meta", label: "Meta webhook rejects unsigned calls", path: "/api/webhooks/meta", init: { method: "POST", body: "{}" } },
    { id: "intake", label: "Lead intake requires its API key", path: "/api/intake", init: { method: "POST", body: "{}" } },
    { id: "cron", label: "Cron endpoint requires auth", path: "/api/cron/automations" },
    { id: "api-auth", label: "Internal API requires a session", path: "/api/quick-create" },
  ];
  // Probe endpoints concurrently so the whole surface sweep stays within the
  // function's time budget (serial probes could stack up to ~40s and get killed).
  const surfaceResults = await Promise.all(
    surface.map(async (s) => {
      const status = await probe(s.path, s.init);
      const blocked = status !== 200 && status !== -1;
      return {
        id: s.id,
        group: "Surface exposure",
        label: s.label,
        status: status === -1 ? "warn" : blocked ? "pass" : "fail",
        detail:
          status === -1
            ? "Endpoint unreachable from the server (could not probe)."
            : `Unauthenticated request returned HTTP ${status}.`,
        fix: blocked || status === -1 ? undefined : "This endpoint answered without authentication — investigate immediately.",
      } as CheckResult;
    })
  );
  surfaceResults.forEach(add);

  /* ── Data protection ────────────────────────────────────────── */
  const dbUrl = process.env.DATABASE_URL ?? "";
  add({
    id: "db-tls",
    group: "Data protection",
    label: "Database over TLS",
    status: dbUrl.includes("sslmode=require") ? "pass" : "fail",
    detail: dbUrl.includes("sslmode=require")
      ? "Connection string enforces sslmode=require."
      : "sslmode=require missing from DATABASE_URL.",
  });

  try {
    const { blobs } = await list({ prefix: "backups/database/" });
    const newest = blobs.sort((a, b) => b.pathname.localeCompare(a.pathname))[0];
    const ageH = newest ? (Date.now() - new Date(newest.uploadedAt).getTime()) / 36e5 : Infinity;
    add({
      id: "backup-fresh",
      group: "Data protection",
      label: "Daily backup ran recently",
      status: ageH <= 36 ? "pass" : ageH <= 72 ? "warn" : "fail",
      detail: newest
        ? `Latest: ${newest.pathname} (${Math.round(ageH)}h ago).`
        : "No backups found in storage.",
      fix: ageH <= 36 ? undefined : "Check /api/cron/backup and the System Log.",
    });
    add({
      id: "backup-enc",
      group: "Data protection",
      label: "Backups are encrypted",
      status: newest?.pathname.endsWith(".json.enc") ? "pass" : newest ? "fail" : "warn",
      detail: newest
        ? newest.pathname.endsWith(".json.enc")
          ? "Latest backup is AES-256-GCM encrypted."
          : "Latest backup is NOT encrypted."
        : "No backup to inspect.",
    });
  } catch {
    add({
      id: "backup-fresh",
      group: "Data protection",
      label: "Daily backup ran recently",
      status: "warn",
      detail: "Blob storage not reachable from this environment.",
    });
  }

  /* ── Accounts & sessions ────────────────────────────────────── */
  const users = await prisma.user.findMany({ select: { name: true, totpEnabledAt: true } });
  const no2fa = users.filter((u) => !u.totpEnabledAt);
  add({
    id: "2fa",
    group: "Accounts & sessions",
    label: "Two-factor authentication",
    status: no2fa.length === 0 ? "pass" : "warn",
    detail:
      no2fa.length === 0
        ? "Every user has 2FA enabled."
        : `Without 2FA: ${no2fa.map((u) => u.name).join(", ")}.`,
    fix: no2fa.length ? "Ask them to enable 2FA under Settings → My Account." : undefined,
  });

  /*
   * NOT tenant-scoped, unlike Settings → System Log. This whole runbook is an
   * install-wide operator report — it probes the deployment, lists every user's
   * 2FA state and reaches blob storage — and it also runs from cron, where there
   * is no session and so no tenant to scope to. Scoping this one line would
   * leave the surface half-scoped while reading as fully scoped, which is worse
   * than leaving it consistently install-wide. It exposes a COUNT, never
   * content.
   *
   * ── THE COUNT WAS RIGHT AND THE ADVICE WAS NOT ──────────────────────────────
   *
   * "27 error(s) in the last 7 days. Fix: Review Settings → System Log." sent
   * the reader to a screen that showed nothing at all, because every one of
   * those 27 had `tenantId: null` and the System Log filters on the acting
   * tenant and deliberately excludes nulls — a tenant cannot be told whose an
   * unattributed error is.
   *
   * Both halves were behaving as designed and the sentence joining them was
   * false. So the count is now SPLIT by whether an error can be traced to a
   * workspace at all, and each part is sent where it can actually be read.
   * Splitting on attribution rather than on the acting tenant also keeps this
   * honest when cron produces the run: the stored answer does not depend on who
   * happened to trigger it.
   *
   * Unattributed errors had no home in the product until this was written; they
   * have one now, and it is where the System Log's own comment always said they
   * belonged. See platform/(console)/errors.
   */
  const errorsSince = new Date(Date.now() - 7 * 864e5);
  const [weekErrors, unattributedErrors] = await Promise.all([
    basePrisma.errorLog.count({ where: { createdAt: { gte: errorsSince } } }),
    basePrisma.errorLog.count({ where: { createdAt: { gte: errorsSince }, tenantId: null } }),
  ]);
  const workspaceErrors = weekErrors - unattributedErrors;
  add({
    id: "errors",
    group: "Accounts & sessions",
    label: "System errors this week",
    status: weekErrors === 0 ? "pass" : "warn",
    detail:
      weekErrors === 0
        ? "No errors logged in 7 days."
        : unattributedErrors === 0
          ? `${weekErrors} error(s) in the last 7 days.`
          : workspaceErrors === 0
            ? `${weekErrors} error(s) in the last 7 days — none belong to a workspace, so Settings → System Log will be empty.`
            : `${weekErrors} error(s) in the last 7 days — ${workspaceErrors} from a workspace, ${unattributedErrors} system-level.`,
    fix:
      weekErrors === 0
        ? undefined
        : unattributedErrors === 0
          ? "Attributed errors are available in each owning workspace's Settings → System Log."
          : workspaceErrors === 0
            ? "These are cron, webhook and boot failures with no owning workspace. A platform administrator can review them in Platform Console → System errors."
            : "Attributed errors are available in each owning workspace's Settings → System Log; system-level errors are in Platform Console → System errors.",
  });

  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const run: RunbookRun = {
    ranAt: new Date().toISOString(),
    score: Math.round((passed / results.length) * 100),
    passed,
    warned,
    failed,
    results,
  };

  // Persist latest + a trimmed history for the accountability trail
  await putSetting("SECURITY_LAST_RUN", JSON.stringify(run));
  try {
    const hist = JSON.parse((await getSetting("SECURITY_HISTORY")) ?? "[]") as {
      ranAt: string;
      score: number;
      failed: number;
      warned: number;
    }[];
    hist.unshift({ ranAt: run.ranAt, score: run.score, failed, warned });
    await putSetting("SECURITY_HISTORY", JSON.stringify(hist.slice(0, 12)));
  } catch {
    /* history is best-effort */
  }
  return run;
}

export async function getLastRun(): Promise<RunbookRun | null> {
  try {
    const raw = await getSetting("SECURITY_LAST_RUN");
    return raw ? (JSON.parse(raw) as RunbookRun) : null;
  } catch {
    return null;
  }
}

export async function getHistory(): Promise<{ ranAt: string; score: number; failed: number; warned: number }[]> {
  try {
    return JSON.parse((await getSetting("SECURITY_HISTORY")) ?? "[]");
  } catch {
    return [];
  }
}
