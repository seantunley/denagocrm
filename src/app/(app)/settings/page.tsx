import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  createStage,
  renameStage,
  moveStage,
  deleteStage,
  saveSetting,
  saveMyProfile,
  saveQuoteDefaults,
  saveWorkshopSettings,
  regenerateSetting,
  saveNotificationPrefs,
} from "@/app/actions/settings";
import { buildSignature } from "@/lib/signature";
import { AddUserForm, ChangePasswordForm } from "@/components/TeamForms";
import {
  saveSmtpSettings,
  saveServiceReminderSettings,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "@/app/actions/emails";
import TestEmailButton from "@/components/TestEmailButton";
import ConfirmDelete from "@/components/ConfirmDelete";
import ImportContactsForm from "@/components/ImportContactsForm";
import PushToggle from "@/components/PushToggle";
import SecurityPanel from "@/components/SecurityPanel";
import OwnerUserControls from "@/components/OwnerUserControls";
import { saveSessionPolicy } from "@/app/actions/security";
import { saveBotSettings, addBotRule, deleteBotRule } from "@/app/actions/bot";
import { saveImapSettings } from "@/app/actions/emails";
import { getBotRules } from "@/lib/bot";
import { clearErrorLog } from "@/app/actions/ai";
import { basePrisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { ABSOLUTE_SESSION_HOURS } from "@/lib/session";
import { decryptValue } from "@/lib/settings";
import { PUSH_KINDS } from "@/lib/push";
import { formatDate } from "@/lib/format";
import AutomationsPage from "../automations/page";
import ProductsPage from "../products/page";
import LibraryPage from "../library/page";

const TABS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "account", label: "My Account" },
  { key: "team", label: "Team" },
  { key: "notifications", label: "Notifications" },
  { key: "email", label: "Email" },
  { key: "quotes", label: "Quotes" },
  { key: "workshop", label: "Workshop" },
  { key: "automations", label: "Automations" },
  { key: "bot", label: "WhatsApp Bot" },
  { key: "products", label: "Products" },
  { key: "library", label: "Library" },
  { key: "integrations", label: "Integrations" },
  { key: "import", label: "Import" },
  { key: "system", label: "System Log" },
] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const currentUser = await requireUser();
  const isAdmin = currentUser.role === "owner";
  // Non-admins get exactly one tab: their own account
  const visibleTabs = isAdmin ? TABS : TABS.filter((t) => t.key === "account");
  const { tab: rawTab } = await searchParams;
  const tab = visibleTabs.some((t) => t.key === rawTab)
    ? rawTab
    : isAdmin
    ? "pipeline"
    : "account";

  const [stages, users, settings, templates] = await Promise.all([
    prisma.pipelineStage.findMany({
      orderBy: { order: "asc" },
      include: { _count: { select: { leads: true } } },
    }),
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.appSetting.findMany(),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
  ]);
  const setting = (key: string) => {
    const raw = settings.find((s) => s.key === key)?.value ?? "";
    try {
      return decryptValue(raw);
    } catch {
      return ""; // encrypted value, key unavailable in this environment
    }
  };
  const isOwner = isAdmin;
  const botRules = isAdmin ? await getBotRules() : [];
  const errorLogs = isAdmin && tab === "system"
    ? await basePrisma.errorLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
    : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="flex gap-1 border-b border-slate-800 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleTabs.map((t) => (
          <Link
            key={t.key}
            href={`/settings?tab=${t.key}`}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? "border-orange-500 text-orange-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "pipeline" && (
        <div className="card">
          <h2 className="font-semibold mb-1">Pipeline stages</h2>
          <p className="text-xs text-slate-400 mb-4">
            The columns of your leads board, in order. Stages holding leads can&apos;t be deleted.
          </p>
          <ul className="space-y-2 mb-4">
            {stages.map((s, i) => (
              <li key={s.id} className="flex items-center gap-2">
                <form action={renameStage.bind(null, s.id)} className="flex items-center gap-2 flex-1">
                  <input type="color" name="color" defaultValue={s.color} className="h-8 w-10 rounded cursor-pointer border border-slate-800" />
                  <input name="name" defaultValue={s.name} className="input flex-1" />
                  <button className="btn-secondary btn-sm">Save</button>
                </form>
                <form action={moveStage.bind(null, s.id, "up")}>
                  <button className="btn-secondary btn-sm" disabled={i === 0}>↑</button>
                </form>
                <form action={moveStage.bind(null, s.id, "down")}>
                  <button className="btn-secondary btn-sm" disabled={i === stages.length - 1}>↓</button>
                </form>
                {s._count.leads > 0 ? (
                  <button className="btn-danger btn-sm" disabled title="Stage still has leads">
                    ✕
                  </button>
                ) : (
                  <ConfirmDelete
                    action={deleteStage.bind(null, s.id)}
                    title={`Delete stage “${s.name}”?`}
                    description="This cannot be undone."
                    trigger="✕"
                    triggerClass="btn-danger btn-sm"
                  />
                )}
              </li>
            ))}
          </ul>
          <form action={createStage} className="flex gap-2">
            <input type="color" name="color" defaultValue="#64748b" className="h-9 w-10 rounded cursor-pointer border border-slate-800" />
            <input name="name" className="input flex-1" placeholder="New stage name…" required />
            <button className="btn-primary">Add stage</button>
          </form>
        </div>
      )}

      {tab === "account" && (
        <div className="max-w-3xl space-y-6">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 shrink-0 rounded-full bg-orange-600 flex items-center justify-center font-bold text-white">
              {currentUser.name
                .split(/\s+/)
                .map((p) => p[0])
                .slice(0, 2)
                .join("")
                .toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="font-semibold flex items-center gap-2 flex-wrap">
                {currentUser.name}
                <span
                  className={`badge ${
                    isOwner ? "bg-orange-500/15 text-orange-300" : "bg-slate-800 text-slate-300"
                  }`}
                >
                  {isOwner ? "Owner" : "Member"}
                </span>
              </p>
              <p className="text-xs text-slate-400 truncate">{currentUser.email}</p>
            </div>
          </div>

          <div className="card p-0 divide-y divide-slate-800">
            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium">Password</span>
                <span className="btn-secondary btn-sm">Change</span>
              </summary>
              <div className="px-5 pb-5 max-w-md">
                <ChangePasswordForm />
              </div>
            </details>

            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium flex items-center gap-2">
                  Two-factor authentication
                  {currentUser.totpEnabledAt ? (
                    <span className="badge bg-emerald-500/15 text-emerald-300">On</span>
                  ) : (
                    <span className="badge bg-amber-500/15 text-amber-300">Off</span>
                  )}
                </span>
                <span className="btn-secondary btn-sm">
                  {currentUser.totpEnabledAt ? "Manage" : "Set up"}
                </span>
              </summary>
              <div className="px-5 pb-5">
                <SecurityPanel
                  totpEnabled={Boolean(currentUser.totpEnabledAt)}
                  emailOtpEnabled={currentUser.emailOtpEnabled}
                />
              </div>
            </details>

            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium">Push notifications</span>
                <span className="btn-secondary btn-sm">Manage</span>
              </summary>
              <div className="px-5 pb-5">
                <p className="text-xs text-slate-400 mb-3">
                  A notification on this device when a lead, DM or signed quote comes in.
                </p>
                <PushToggle />
              </div>
            </details>

            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium">Email signature</span>
                <span className="btn-secondary btn-sm">View &amp; edit</span>
              </summary>
              <div className="px-5 pb-5 space-y-4">
                <div
                  className="rounded-lg bg-white p-4 overflow-x-auto"
                  dangerouslySetInnerHTML={{ __html: buildSignature(currentUser) }}
                />
                <form action={saveMyProfile} className="space-y-3 max-w-md">
                  <div>
                    <label className="label">My mobile number</label>
                    <input
                      name="mobile"
                      className="input"
                      defaultValue={currentUser.mobile ?? ""}
                      placeholder="e.g. 082 123 4567"
                    />
                  </div>
                  <div>
                    <label className="label">Custom signature HTML (optional)</label>
                    <textarea
                      name="signatureHtml"
                      className="input font-mono text-xs"
                      rows={4}
                      defaultValue={currentUser.signatureHtml ?? ""}
                      placeholder="Leave blank to use the branded signature (recommended)."
                    />
                  </div>
                  <button className="btn-primary btn-sm">Save</button>
                </form>
              </div>
            </details>
          </div>
        </div>
      )}

      {tab === "team" && (
        <div className="max-w-3xl space-y-6">
          <div className="card p-0 overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>2FA</th>
                  {isOwner && <th className="text-right">Manage</th>}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <p className="font-medium">
                        {u.name}
                        {u.id === currentUser.id && (
                          <span className="text-xs text-slate-500 ml-1.5">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-slate-400">{u.email}</p>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          u.role === "owner"
                            ? "bg-orange-500/15 text-orange-300"
                            : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {u.role === "owner" ? "Admin" : "Member"}
                      </span>
                    </td>
                    <td>
                      {u.totpEnabledAt || u.emailOtpEnabled ? (
                        <span className="badge bg-emerald-500/15 text-emerald-300">On</span>
                      ) : (
                        <span className="badge bg-amber-500/15 text-amber-300">Off</span>
                      )}
                    </td>
                    {isOwner && (
                      <td className="text-right">
                        {u.id !== currentUser.id && (
                          <OwnerUserControls
                            userId={u.id}
                            name={u.name}
                            role={u.role as "owner" | "member"}
                            modules={u.modules}
                            has2fa={Boolean(u.totpEnabledAt || u.emailOtpEnabled)}
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isOwner && (
            <div className="card p-0 divide-y divide-slate-800">
              <details>
                <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className="text-sm font-medium">Add a team member</span>
                  <span className="btn-secondary btn-sm">+ Add</span>
                </summary>
                <div className="px-5 pb-5 max-w-md">
                  <AddUserForm />
                </div>
              </details>

              <form
                action={saveSessionPolicy}
                className="flex items-center justify-between gap-4 px-5 py-4 flex-wrap"
              >
                <div>
                  <p className="text-sm font-medium">Auto sign-out after inactivity</p>
                  <p className="text-xs text-slate-500">
                    Everyone re-signs in at least every {ABSOLUTE_SESSION_HOURS}h regardless.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    name="idleMinutes"
                    className="input w-36"
                    defaultValue={setting("SESSION_IDLE_MINUTES") || "60"}
                  >
                    <option value="15">15 minutes</option>
                    <option value="30">30 minutes</option>
                    <option value="60">1 hour</option>
                    <option value="120">2 hours</option>
                    <option value="240">4 hours</option>
                    <option value="480">8 hours</option>
                    <option value="1440">24 hours</option>
                  </select>
                  <button className="btn-primary btn-sm">Save</button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {tab === "notifications" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium">Push on this device</span>
                <span className="btn-secondary btn-sm">Manage</span>
              </summary>
              <div className="px-5 pb-5">
                <p className="text-xs text-slate-400 mb-3">
                  Each phone/computer opts in separately. Install the app on your phone for
                  lock-screen notifications.
                </p>
                <PushToggle />
              </div>
            </details>

            <form action={saveNotificationPrefs} className="px-5 py-4">
              <p className="text-sm font-medium">What sends a notification</p>
              <p className="text-xs text-slate-500 mb-3">
                Applies to the whole team&apos;s devices. Untick to silence a type everywhere.
              </p>
              <div className="space-y-2.5">
                {PUSH_KINDS.map((k) => (
                  <label key={k.id} className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      name="kinds"
                      value={k.id}
                      defaultChecked={!(setting("PUSH_DISABLED_KINDS") || "").split(",").includes(k.id)}
                      className="h-4 w-4 mt-0.5"
                    />
                    <span className="text-sm leading-5">
                      {k.label}
                      <span className="block text-xs text-slate-500">{k.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              <button className="btn-primary btn-sm mt-4">Save</button>
            </form>
          </div>
        </div>
      )}

      {tab === "bot" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <form action={saveBotSettings} className="px-5 py-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium">Auto-replies on WhatsApp</p>
                  <p className="text-xs text-slate-500">
                    Keyword rules answer instantly, any time. Outside office hours an away
                    message is sent (max once per customer per 4 hours). Everything else waits
                    for a human — you still get the push.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={setting("BOT_ENABLED") === "true"}
                    className="h-4 w-4"
                  />
                  Enabled
                </label>
              </div>
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <label className="label">Office hours</label>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="time"
                      name="start"
                      className="input w-28"
                      defaultValue={(setting("BOT_HOURS") || "08:00-17:00").split("-")[0]}
                    />
                    <span className="text-slate-500">–</span>
                    <input
                      type="time"
                      name="end"
                      className="input w-28"
                      defaultValue={(setting("BOT_HOURS") || "08:00-17:00").split("-")[1]}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">Days</label>
                  <div className="flex gap-2 flex-wrap">
                    {[["1","Mo"],["2","Tu"],["3","We"],["4","Th"],["5","Fr"],["6","Sa"],["7","Su"]].map(([v,l]) => (
                      <label key={v} className="flex items-center gap-1 text-xs text-slate-300 cursor-pointer">
                        <input
                          type="checkbox"
                          name="days"
                          value={v}
                          defaultChecked={(setting("BOT_DAYS") || "1,2,3,4,5").split(",").includes(v)}
                          className="h-3.5 w-3.5"
                        />
                        {l}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="label">After-hours away message</label>
                <textarea
                  name="afterhours"
                  className="input"
                  rows={2}
                  defaultValue={setting("BOT_AFTERHOURS_MSG") || "Thanks for your message! Our showroom is open Mon–Fri 08:00–17:00 — we'll get back to you first thing. For urgent matters call 073 789 3438."}
                />
              </div>
              <button className="btn-primary btn-sm">Save bot settings</button>
            </form>

            <div className="px-5 py-4">
              <p className="text-sm font-medium mb-1">Keyword rules</p>
              <p className="text-xs text-slate-500 mb-3">
                If a message contains any keyword, the reply goes out instantly and is logged on
                the customer&apos;s record.
              </p>
              <ul className="space-y-2 mb-3">
                {botRules.length === 0 && (
                  <li className="text-xs text-slate-500">
                    No rules yet — e.g. keywords “price, cost, how much” → reply with the price
                    list link.
                  </li>
                )}
                {botRules.map((r) => (
                  <li
                    key={r.id}
                    className="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2 flex items-start gap-3"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-orange-300">{r.keywords}</p>
                      <p className="text-xs text-slate-400 whitespace-pre-wrap">{r.reply}</p>
                    </div>
                    <form action={deleteBotRule.bind(null, r.id)}>
                      <button className="text-xs text-slate-600 hover:text-red-400 cursor-pointer">
                        ✕
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
              <details className="rounded-lg border border-slate-800 bg-slate-800/40">
                <summary className="px-3 py-2 text-sm font-medium cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                  + Add rule
                </summary>
                <form action={addBotRule} className="p-3 pt-1 space-y-2">
                  <input
                    name="keywords"
                    className="input"
                    required
                    placeholder="Keywords, comma-separated — e.g. price, cost, how much"
                  />
                  <textarea
                    name="reply"
                    className="input"
                    rows={3}
                    required
                    placeholder="Reply — e.g. You can view our full price list here: https://denagocpt.co.za/models — a team member will follow up shortly!"
                  />
                  <button className="btn-primary btn-sm">Add rule</button>
                </form>
              </details>
            </div>
          </div>
        </div>
      )}

      {tab === "system" && (
        <div className="max-w-3xl space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-400">
              System errors from syncs, webhooks, email/SMS and unhandled crashes. Auto-purged
              after 30 days. A push fires on the first error in any 30-minute window.
            </p>
            {errorLogs.length > 0 && (
              <form action={clearErrorLog}>
                <button className="btn-secondary btn-sm">Clear log</button>
              </form>
            )}
          </div>
          <div className="card p-0 divide-y divide-slate-800">
            {errorLogs.length === 0 ? (
              <p className="text-sm text-slate-400 p-5">No errors on record. 🎉</p>
            ) : (
              errorLogs.map((e) => (
                <details key={e.id}>
                  <summary className="px-4 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-baseline gap-2">
                    <span className="badge bg-red-500/15 text-red-300 shrink-0">{e.scope}</span>
                    <span className="text-sm truncate flex-1">{e.message}</span>
                    <span className="text-[11px] text-slate-500 shrink-0">
                      {formatDateTime(e.createdAt)}
                    </span>
                  </summary>
                  <div className="px-4 pb-3">
                    {e.context && <p className="text-xs text-slate-400 mb-1">{e.context}</p>}
                    {e.stack && (
                      <pre className="text-[10px] text-slate-500 whitespace-pre-wrap max-h-40 overflow-y-auto">
                        {e.stack}
                      </pre>
                    )}
                  </div>
                </details>
              ))
            )}
          </div>
        </div>
      )}

      {tab === "email" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <Row
              title="Email sending (SMTP)"
              status={
                setting("SMTP_HOST") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Used for all outgoing email. Works with any SMTP provider (your denagocpt.co.za
                mailbox, Google Workspace, Resend, SendGrid).
              </p>
              <form action={saveSmtpSettings} className="grid md:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="label">SMTP host</label>
                  <input name="host" className="input" defaultValue={setting("SMTP_HOST")} placeholder="mail.denagocpt.co.za" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Port</label>
                    <input name="port" className="input" defaultValue={setting("SMTP_PORT") || "587"} />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      name="secure"
                      id="secure"
                      defaultChecked={setting("SMTP_SECURE") === "true"}
                      className="h-4 w-4"
                    />
                    <label htmlFor="secure" className="text-sm text-slate-400">
                      SSL (port 465)
                    </label>
                  </div>
                </div>
                <div>
                  <label className="label">Username</label>
                  <input name="user" className="input" defaultValue={setting("SMTP_USER")} placeholder="sales@denagocpt.co.za" />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input name="pass" type="password" className="input" defaultValue={setting("SMTP_PASS")} />
                </div>
                <div className="md:col-span-2">
                  <label className="label">From address</label>
                  <input
                    name="from"
                    className="input"
                    defaultValue={setting("SMTP_FROM")}
                    placeholder={'"Denago Cape Town" <sales@denagocpt.co.za>'}
                  />
                </div>
                <div className="md:col-span-2">
                  <button className="btn-primary">Save email settings</button>
                </div>
              </form>
              <TestEmailButton />
            </Row>

            <Row
              title="Incoming email (IMAP)"
              status={
                setting("IMAP_HOST") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Customer replies land on their record automatically (checked every 15 minutes,
                read-only — nothing is moved or marked in the mailbox). Unknown senders are left
                alone. Usually the same details as SMTP with port 993.
              </p>
              <form action={saveImapSettings} className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="label">IMAP host</label>
                  <input name="host" className="input" defaultValue={setting("IMAP_HOST")} placeholder="mail.denagocpt.co.za" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Port</label>
                    <input name="port" className="input" defaultValue={setting("IMAP_PORT") || "993"} />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      name="secure"
                      id="imap-secure"
                      defaultChecked={setting("IMAP_SECURE") !== "false"}
                      className="h-4 w-4"
                    />
                    <label htmlFor="imap-secure" className="text-sm text-slate-400">SSL</label>
                  </div>
                </div>
                <div>
                  <label className="label">Username</label>
                  <input name="user" className="input" defaultValue={setting("IMAP_USER")} placeholder="sales@denagocpt.co.za" />
                </div>
                <div>
                  <label className="label">Password</label>
                  <input name="pass" type="password" className="input" defaultValue={setting("IMAP_PASS")} />
                </div>
                <div className="md:col-span-2">
                  <button className="btn-primary">Save incoming email</button>
                </div>
              </form>
            </Row>

            <Row
              title="Service reminders to customers"
              status={
                setting("SERVICE_REMINDER_ENABLED") === "true" ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">On</span>
                ) : (
                  <span className="badge bg-slate-800 text-slate-400">Off</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Customers whose vehicle is due for a service get one automatic email per
                due-cycle. Placeholders: <code>{"{{first_name}}"}</code>,{" "}
                <code>{"{{model}}"}</code>, <code>{"{{due_date}}"}</code>,{" "}
                <code>{"{{due_km}}"}</code>, <code>{"{{current_km}}"}</code>.
              </p>
              <form action={saveServiceReminderSettings} className="flex items-end gap-3 flex-wrap">
                <div className="flex items-center gap-2 pb-2">
                  <input
                    type="checkbox"
                    name="enabled"
                    id="sr-enabled"
                    defaultChecked={setting("SERVICE_REMINDER_ENABLED") === "true"}
                    className="h-4 w-4"
                  />
                  <label htmlFor="sr-enabled" className="text-sm text-slate-300">
                    Enabled
                  </label>
                </div>
                <div className="flex-1 min-w-56">
                  <label className="label">Email template</label>
                  <select
                    name="templateId"
                    className="input"
                    defaultValue={setting("SERVICE_REMINDER_TEMPLATE_ID")}
                  >
                    <option value="">— choose template —</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn-primary">Save</button>
              </form>
            </Row>

            <Row
              title="Email templates"
              status={
                <span className="badge bg-slate-800 text-slate-300">{templates.length}</span>
              }
              action="Manage"
            >
              <p className="text-xs text-slate-400 mb-4">
                Placeholders: <code>{"{{name}}"}</code>, <code>{"{{first_name}}"}</code>,{" "}
                <code>{"{{model}}"}</code>, <code>{"{{color}}"}</code>, <code>{"{{value}}"}</code>,{" "}
                <code>{"{{user_name}}"}</code> — filled from the lead/contact when sending.
              </p>
              <div className="space-y-3 mb-4">
                {templates.map((t) => (
                  <details key={t.id} className="rounded-lg border border-slate-800 bg-slate-800/40">
                    <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium">
                      {t.name}
                    </summary>
                    <div className="p-4 pt-1 space-y-2">
                      <form action={updateTemplate.bind(null, t.id)} className="space-y-2">
                        <input name="name" className="input" defaultValue={t.name} required />
                        <input name="subject" className="input" defaultValue={t.subject} required />
                        <textarea name="body" className="input" rows={5} defaultValue={t.body} required />
                        <button className="btn-primary btn-sm">Save template</button>
                      </form>
                      <ConfirmDelete
                        action={deleteTemplate.bind(null, t.id)}
                        title={`Delete template “${t.name}”?`}
                        description="This cannot be undone. Automations using this template will skip their email step."
                        trigger="Delete"
                        triggerClass="btn-danger btn-sm"
                      />
                    </div>
                  </details>
                ))}
              </div>
              <details className="rounded-lg border border-slate-800 bg-slate-800/40">
                <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium">
                  + New template
                </summary>
                <form action={createTemplate} className="p-4 pt-1 space-y-2">
                  <input name="name" className="input" placeholder="Template name (e.g. New lead welcome)" required />
                  <input name="subject" className="input" placeholder="Subject — e.g. Your {{model}} enquiry" required />
                  <textarea
                    name="body"
                    className="input"
                    rows={5}
                    required
                    placeholder={"Hi {{first_name}},\n\nThanks for your interest in the {{model}}…\n\n{{user_name}}\nDenago Cape Town · 073 789 3438"}
                  />
                  <button className="btn-primary btn-sm">Create template</button>
                </form>
              </details>
            </Row>
          </div>
        </div>
      )}

      {tab === "import" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <Row title="Import contacts from CSV" action="Import">
              <p className="text-xs text-slate-400 mb-4">
                Upload a CSV with a header row. Recognised columns: Name (or First Name / Last
                Name), Email, Phone, WhatsApp, Company, Address, Suburb, City, Province, Postal
                Code, Notes, Source. Contacts matching an existing email or phone are skipped —
                safe to re-run.
              </p>
              <ImportContactsForm />
            </Row>
          </div>
        </div>
      )}

      {tab === "quotes" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <Row
              title="Quote defaults"
              status={
                <span className="badge bg-slate-800 text-slate-300">
                  valid {setting("QUOTE_VALID_DAYS") || "7"} days
                </span>
              }
              action="Edit"
            >
              <p className="text-xs text-slate-400 mb-4">
                Applied to new quotes; each quote can still be adjusted individually.
              </p>
              <form action={saveQuoteDefaults} className="space-y-4 max-w-xl">
                <div>
                  <label className="label">Valid for (days)</label>
                  <input
                    name="validDays"
                    type="number"
                    min={1}
                    className="input w-32"
                    defaultValue={setting("QUOTE_VALID_DAYS") || "7"}
                  />
                </div>
                <div>
                  <label className="label">Default terms (one bullet per line)</label>
                  <textarea
                    name="terms"
                    className="input"
                    rows={6}
                    defaultValue={
                      setting("QUOTE_TERMS") ||
                      "Prices include VAT. Delivery arranged on acceptance. E&OE."
                    }
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Each line becomes its own bullet point on the printed quote.
                  </p>
                </div>
                <button className="btn-primary">Save quote defaults</button>
              </form>
            </Row>
          </div>
        </div>
      )}

      {tab === "workshop" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <Row
              title="Online booking slots"
              status={
                <span className="badge bg-slate-800 text-slate-300">
                  {(setting("BOOKING_SLOT_TIMES") || "08:00,10:00,12:00,14:00").split(",").length}{" "}
                  per day
                </span>
              }
              action="Edit"
            >
              <p className="text-xs text-slate-400 mb-4">
                Customers booking a service on denagocpt.co.za can only pick these slots. A slot
                disappears from the website the moment it&apos;s taken.
              </p>
              <form action={saveWorkshopSettings} className="space-y-4 max-w-xl">
                <div>
                  <label className="label">Slot start times (comma-separated, 24h)</label>
                  <input
                    name="times"
                    className="input"
                    defaultValue={setting("BOOKING_SLOT_TIMES") || "08:00,10:00,12:00,14:00"}
                  />
                </div>
                <div>
                  <label className="label">Booking days</label>
                  <div className="flex gap-3 flex-wrap">
                    {[
                      ["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"],
                      ["5", "Fri"], ["6", "Sat"], ["7", "Sun"],
                    ].map(([val, label]) => (
                      <label key={val} className="flex items-center gap-1.5 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          name="days"
                          value={val}
                          defaultChecked={(setting("BOOKING_DAYS") || "1,2,3,4,5").split(",").includes(val)}
                          className="h-4 w-4"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Vehicles per slot</label>
                    <input
                      name="capacity"
                      type="number"
                      min={1}
                      className="input"
                      defaultValue={setting("BOOKING_CAPACITY") || "1"}
                    />
                  </div>
                  <div>
                    <label className="label">Bookable days ahead</label>
                    <input
                      name="horizon"
                      type="number"
                      min={1}
                      className="input"
                      defaultValue={setting("BOOKING_HORIZON_DAYS") || "30"}
                    />
                  </div>
                </div>
                <button className="btn-primary">Save workshop settings</button>
              </form>
            </Row>
          </div>
        </div>
      )}

      {tab === "automations" && <AutomationsPage />}
      {tab === "products" && <ProductsPage />}
      {tab === "library" && <LibraryPage />}

      {tab === "integrations" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-slate-800">
            <Row
              title="Facebook & Instagram (Meta)"
              status={
                setting("META_PAGE_ACCESS_TOKEN") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Powers lead ads and Messenger/Instagram DMs. Webhook (leadgen + messages fields):
              </p>
              <div className="space-y-3">
                <div>
                  <label className="label">Webhook callback URL</label>
                  <code className="block text-sm bg-slate-800 rounded-lg px-3 py-2">
                    https://crm.denagocpt.co.za/api/webhooks/meta
                  </code>
                </div>
                <div>
                  <label className="label">Verify token</label>
                  <div className="flex gap-2">
                    <code className="flex-1 text-sm bg-slate-800 rounded-lg px-3 py-2 break-all">
                      {setting("META_VERIFY_TOKEN") || "—"}
                    </code>
                    <form action={regenerateSetting.bind(null, "META_VERIFY_TOKEN")}>
                      <button className="btn-secondary">Regenerate</button>
                    </form>
                  </div>
                </div>
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="META_PAGE_ACCESS_TOKEN" />
                  <div className="flex-1">
                    <label className="label">Page access token (System User)</label>
                    <input
                      name="value"
                      type="password"
                      className="input"
                      defaultValue={setting("META_PAGE_ACCESS_TOKEN")}
                      placeholder="EAAG…"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="META_APP_SECRET" />
                  <div className="flex-1">
                    <label className="label">App secret (verifies webhook signatures)</label>
                    <input
                      name="value"
                      type="password"
                      className="input"
                      defaultValue={setting("META_APP_SECRET")}
                      placeholder="From Meta app → Settings → Basic"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
              </div>
            </Row>

            <Row
              title="WhatsApp Business (Cloud API)"
              status={
                setting("WA_PHONE_NUMBER_ID") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Connect your dedicated WhatsApp number: add the <b>WhatsApp</b> product in your
                Meta app, register the number, subscribe the webhook below to the <b>messages</b>{" "}
                field (same verify token and app secret as above).
              </p>
              <div className="space-y-3">
                <div>
                  <label className="label">Webhook callback URL</label>
                  <code className="block text-sm bg-slate-800 rounded-lg px-3 py-2">
                    https://crm.denagocpt.co.za/api/webhooks/whatsapp
                  </code>
                </div>
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="WA_PHONE_NUMBER_ID" />
                  <div className="flex-1">
                    <label className="label">Phone number ID</label>
                    <input
                      name="value"
                      className="input"
                      defaultValue={setting("WA_PHONE_NUMBER_ID")}
                      placeholder="From WhatsApp → API Setup"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="WA_ACCESS_TOKEN" />
                  <div className="flex-1">
                    <label className="label">Access token (permanent, System User)</label>
                    <input
                      name="value"
                      type="password"
                      className="input"
                      defaultValue={setting("WA_ACCESS_TOKEN")}
                      placeholder="EAAG…"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
              </div>
            </Row>

            <Row
              title="Google reviews"
              status={
                setting("GOOGLE_PLACES_API_KEY") && setting("GOOGLE_PLACE_ID") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                New reviews appear in the Social inbox with a push notification. Needs a Google
                Cloud API key with the <b>Places API (New)</b> enabled, plus your Place ID.
              </p>
              <div className="space-y-3">
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="GOOGLE_PLACES_API_KEY" />
                  <div className="flex-1">
                    <label className="label">Places API key</label>
                    <input
                      name="value"
                      type="password"
                      className="input"
                      defaultValue={setting("GOOGLE_PLACES_API_KEY")}
                      placeholder="AIza…"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="GOOGLE_PLACE_ID" />
                  <div className="flex-1">
                    <label className="label">Place ID</label>
                    <input
                      name="value"
                      className="input"
                      defaultValue={setting("GOOGLE_PLACE_ID")}
                      placeholder="ChIJ…"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
              </div>
            </Row>

            <Row
              title="SMS one-time codes (BulkSMS)"
              status={
                setting("BULKSMS_TOKEN_ID") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Sends OTPs to customers verifying their vehicle on the website booking form.
                Create a free account at bulksms.com → Settings → Developer → API Tokens.
                Without this, codes fall back to the customer&apos;s registered email.
              </p>
              <div className="space-y-3">
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="BULKSMS_TOKEN_ID" />
                  <div className="flex-1">
                    <label className="label">Token ID</label>
                    <input
                      name="value"
                      className="input"
                      defaultValue={setting("BULKSMS_TOKEN_ID")}
                      placeholder="From BulkSMS → API Tokens"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="BULKSMS_TOKEN_SECRET" />
                  <div className="flex-1">
                    <label className="label">Token secret</label>
                    <input
                      name="value"
                      type="password"
                      className="input"
                      defaultValue={setting("BULKSMS_TOKEN_SECRET")}
                      placeholder="Shown once when the token is created"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
              </div>
            </Row>

            <Row
              title="AI Assist (Claude)"
              status={
                setting("ANTHROPIC_API_KEY") ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">Connected</span>
                ) : (
                  <span className="badge bg-amber-500/15 text-amber-300">Not set up</span>
                )
              }
            >
              <p className="text-xs text-slate-400 mb-4">
                Powers the ✨ message check, 🔎 lead research and (optionally) automatic research
                on new leads. Suggestions only — the AI never changes data. Get a key at
                console.anthropic.com.
              </p>
              <div className="space-y-3">
                <form action={saveSetting} className="flex gap-2 items-end">
                  <input type="hidden" name="key" value="ANTHROPIC_API_KEY" />
                  <div className="flex-1">
                    <label className="label">Anthropic API key</label>
                    <input
                      name="value"
                      type="password"
                      className="input"
                      defaultValue={setting("ANTHROPIC_API_KEY")}
                      placeholder="sk-ant-…"
                    />
                  </div>
                  <button className="btn-primary">Save</button>
                </form>
                <form action={saveSetting} className="flex items-center gap-2">
                  <input type="hidden" name="key" value="AI_AUTO_RESEARCH" />
                  <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      name="value"
                      value="true"
                      defaultChecked={setting("AI_AUTO_RESEARCH") === "true"}
                      className="h-4 w-4"
                    />
                    Automatically research every new lead (files a note within ~15 min)
                  </label>
                  <button className="btn-secondary btn-sm">Save</button>
                </form>
              </div>
            </Row>

            <Row
              title="Website lead intake API"
              status={<span className="badge bg-emerald-500/15 text-emerald-300">Active</span>}
              action="View"
            >
              <p className="text-xs text-slate-400 mb-4">
                POST leads from the website or landing pages with the <code>X-Api-Key</code>{" "}
                header. Fields: name (required), email, phone, message, model, color, source.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="label">API key</label>
                  <div className="flex gap-2">
                    <code className="flex-1 text-sm bg-slate-800 rounded-lg px-3 py-2 break-all">
                      {setting("INTAKE_API_KEY") || "—"}
                    </code>
                    <form action={regenerateSetting.bind(null, "INTAKE_API_KEY")}>
                      <button className="btn-secondary">Regenerate</button>
                    </form>
                  </div>
                </div>
              </div>
            </Row>
          </div>
        </div>
      )}
    </div>
  );
}

/** One settings row: label + status left, action button right, form folds out below. */
function Row({
  title,
  status,
  action = "Configure",
  children,
}: {
  title: string;
  status?: React.ReactNode;
  action?: string;
  children: React.ReactNode;
}) {
  return (
    <details>
      <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-medium flex items-center gap-2 flex-wrap">
          {title}
          {status}
        </span>
        <span className="btn-secondary btn-sm shrink-0">{action}</span>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}
