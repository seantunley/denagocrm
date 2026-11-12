/**
 * Settings → Integrations, as an owner reads it (settings-screens-improvements.md,
 * 2026-11-12): grouped by what each integration is FOR, one line on why you'd
 * bother, ONE status vocabulary, and a button that matches the status.
 *
 * Pure — no server or database imports — so the page and its tests share it.
 */

export type IntegrationGroupKey = "attention" | "messaging" | "email" | "accounting" | "ai" | "other";

export const INTEGRATION_GROUPS: ReadonlyArray<{ key: IntegrationGroupKey; label: string; description: string }> = [
  { key: "attention", label: "Needs attention", description: "Stopped working or only half set up — fix these first." },
  { key: "messaging", label: "Messaging channels", description: "Where customers reach you, in the Inbox." },
  { key: "email", label: "Email", description: "Sending and receiving email." },
  { key: "accounting", label: "Accounting", description: "Invoices and payments." },
  { key: "ai", label: "AI", description: "The assistant, the chatbot's brain, and voice." },
  { key: "other", label: "Other services", description: "Reviews, addresses, website leads and webhooks." },
];

/** A small mark per row, so the list scans at a glance. `tone` is a Tailwind bg/text pair. */
export type IntegrationMark = { text: string; tone: string };

export type IntegrationMeta = { group: Exclude<IntegrationGroupKey, "attention">; purpose: string; mark: IntegrationMark };

/** Every row on the page — the per-workspace credentials and the platform owner's own rows. */
export const INTEGRATION_META: Record<string, IntegrationMeta> = {
  whatsapp: { group: "messaging", purpose: "Send and receive WhatsApp messages in the Inbox.", mark: { text: "WA", tone: "bg-emerald-500/15 text-emerald-300" } },
  meta: { group: "messaging", purpose: "Facebook Messenger and Instagram messages, and lead ads, in the Inbox.", mark: { text: "Me", tone: "bg-blue-500/15 text-blue-300" } },
  x: { group: "messaging", purpose: "X messages, mentions and replies in the Inbox.", mark: { text: "X", tone: "bg-zinc-500/20 text-zinc-100" } },
  telegram: { group: "messaging", purpose: "Telegram messages in the Inbox, answered by the chatbot.", mark: { text: "Tg", tone: "bg-sky-500/15 text-sky-300" } },
  sms: { group: "messaging", purpose: "Text one-time codes to signers who need them.", mark: { text: "SMS", tone: "bg-violet-500/15 text-violet-300" } },
  smtp: { group: "email", purpose: "Send quotes, invoices and messages from your own mail server.", mark: { text: "Out", tone: "bg-orange-500/15 text-orange-300" } },
  imap: { group: "email", purpose: "Bring replies from your mailbox into the Inbox.", mark: { text: "In", tone: "bg-orange-500/15 text-orange-300" } },
  xero: { group: "accounting", purpose: "Send invoices to Xero and bring payments back.", mark: { text: "Xe", tone: "bg-cyan-500/15 text-cyan-300" } },
  "ai-choice": { group: "ai", purpose: "Which AI runs the chatbot, invoice reading and message checks.", mark: { text: "AI", tone: "bg-primary/15 text-primary" } },
  chatgpt: { group: "ai", purpose: "Run DAX and the AI helpers on your ChatGPT plan, with no per-use cost.", mark: { text: "GPT", tone: "bg-teal-500/15 text-teal-300" } },
  claude: { group: "ai", purpose: "Pay-per-use Claude, when chosen above or if ChatGPT isn't connected.", mark: { text: "Cl", tone: "bg-amber-500/15 text-amber-300" } },
  elevenlabs: { group: "ai", purpose: "Hear voice notes and reply with a voice.", mark: { text: "11", tone: "bg-fuchsia-500/15 text-fuchsia-300" } },
  "google-reviews": { group: "other", purpose: "Bring your Google reviews into the CRM.", mark: { text: "G★", tone: "bg-yellow-500/15 text-yellow-300" } },
  "google-maps": { group: "other", purpose: "Suggest real addresses while booking test drives and meetings.", mark: { text: "Map", tone: "bg-green-500/15 text-green-300" } },
  intake: { group: "other", purpose: "Take leads from your website and landing pages.", mark: { text: "Web", tone: "bg-indigo-500/15 text-indigo-300" } },
  webhooks: { group: "other", purpose: "The addresses X, Meta and WhatsApp deliver messages to.", mark: { text: "⇄", tone: "bg-slate-500/20 text-slate-200" } },
};

/**
 * The ONE vocabulary: three states, "saved but never checked", and two that need
 * attention and rise to the top.
 */
export type IntegrationState = "connected" | "unverified" | "shared" | "not-set-up" | "reconnect" | "incomplete";

export const STATE_LABEL: Record<IntegrationState, string> = {
  connected: "Connected",
  unverified: "Saved, not checked",
  shared: "Using shared setup",
  "not-set-up": "Not set up",
  reconnect: "Reconnect needed",
  incomplete: "Half set up",
};

export const STATE_TONE: Record<IntegrationState, string> = {
  connected: "bg-emerald-500/15 text-emerald-300",
  unverified: "bg-amber-500/15 text-amber-300",
  shared: "bg-muted text-muted-foreground",
  "not-set-up": "bg-muted text-muted-foreground",
  reconnect: "bg-red-500/15 text-red-300",
  incomplete: "bg-amber-500/15 text-amber-300",
};

export const needsAttention = (state: IntegrationState) => state === "reconnect" || state === "incomplete";

/** One button that matches the state: Connect when there's nothing, Check when it was never tested, Fix when it's broken, Manage otherwise. */
export function integrationAction(state: IntegrationState): "Connect" | "Check" | "Manage" | "Fix" {
  if (state === "not-set-up") return "Connect";
  if (state === "unverified") return "Check";
  if (needsAttention(state)) return "Fix";
  return "Manage";
}

/**
 * Which values a per-workspace integration runs on: its own, half its own, or the shared setup.
 *
 * Xero is an OAuth connection, not typed values — every field is optional and
 * nothing is shared (an organisation belongs to one workspace). Its own setup IS
 * the connected organisation, and there is never a shared one: an empty
 * required-field list must not read as "every shared value is there" (review of #1083).
 */
export function workspaceValueUse(input: {
  integrationId: string;
  overrideStatus: "active" | "incomplete" | "default";
  requiredKeys: readonly string[];
  hasOverride: Record<string, boolean>;
  effectiveSet: Record<string, boolean>;
}): { ownStatus: "active" | "incomplete" | "default"; sharedInUse: boolean } {
  if (input.integrationId === "xero") return { ownStatus: input.hasOverride.XERO_TENANT_ID ? "active" : "default", sharedInUse: false };
  const ownStatus = input.overrideStatus;
  // The shared values are in use only when this workspace's own set isn't, and every required one is there.
  const sharedInUse = ownStatus !== "active" && input.requiredKeys.length > 0 && input.requiredKeys.every((key) => input.effectiveSet[key]);
  return { ownStatus, sharedInUse };
}

/**
 * A per-workspace integration's state. "Connected" needs BOTH: values in use, and
 * the last check (a test, a successful send, the Xero sign-in) passed. Values typed
 * in but never proven are "Saved, not checked" — not Connected (review of #1083).
 */
export function workspaceIntegrationState(input: {
  needsReauth: boolean;
  verified: boolean;
  ownStatus: "active" | "incomplete" | "default";
  sharedInUse: boolean;
}): IntegrationState {
  if (input.needsReauth) return "reconnect";
  // Half-entered own values stay in Needs attention even while the shared setup keeps
  // sending successfully — that success proves the shared values, not these (re-review of #1083).
  if (input.ownStatus === "incomplete") return "incomplete";
  const inUse = input.ownStatus === "active" || input.sharedInUse;
  if (input.verified && inUse) return "connected";
  if (input.ownStatus === "active") return "unverified";
  if (input.sharedInUse) return "shared";
  return "not-set-up";
}

/** "5 minutes ago" — for "last checked …". */
export function checkedAgo(at: Date, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

/**
 * What a per-workspace integration is connected TO — from non-secret values only
 * (the page passes `effectiveShown`, which never holds a secret).
 */
export function connectedTo(integrationId: string, shown: Record<string, string | undefined>): string | null {
  switch (integrationId) {
    case "whatsapp":
      return shown.WA_PHONE_NUMBER_ID ? `Phone number ID ${shown.WA_PHONE_NUMBER_ID}` : null;
    case "smtp":
      return shown.SMTP_FROM ? `Sends as ${shown.SMTP_FROM}` : shown.SMTP_HOST ? `Through ${shown.SMTP_HOST}` : null;
    case "imap":
      return shown.IMAP_USER ? `Reads ${shown.IMAP_USER}` : shown.IMAP_HOST ? `From ${shown.IMAP_HOST}` : null;
    case "xero":
      return shown.XERO_ORG_NAME ? `Organisation: ${shown.XERO_ORG_NAME}` : null;
    case "x":
      return shown.X_USERNAME ? `@${shown.X_USERNAME.replace(/^@/, "")}` : null;
    case "google-reviews":
      return shown.GOOGLE_PLACE_ID ? `Place ID ${shown.GOOGLE_PLACE_ID}` : null;
    default:
      return null;
  }
}

/** Rows grouped for the page: anything needing attention first, in its own group; then by purpose, in order. */
export function groupIntegrationRows<T extends { id: string; state: IntegrationState }>(rows: T[]) {
  return INTEGRATION_GROUPS.map((group) => ({
    group,
    rows: rows.filter((row) =>
      // An integration added later without an entry above still shows — under Other services.
      group.key === "attention" ? needsAttention(row.state) : !needsAttention(row.state) && (INTEGRATION_META[row.id]?.group ?? "other") === group.key,
    ),
  })).filter((entry) => entry.rows.length > 0);
}
