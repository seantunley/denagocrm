import { prisma } from "@/lib/db";
import { actingTenantMemberIds } from "@/lib/tenantActor";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { getActiveTenantId, isTenantOwner, requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  saveMyProfile,
  saveQuoteDefaults,
  saveRegionalSettings,
  saveWorkshopSettings,
  saveNotificationPrefs,
} from "@/app/actions/settings";
import { signatureCompanyFrom, buildSignature } from "@/lib/signature";
import { getCompanyProfile } from "@/lib/companyProfile";
import { tenantOrigin } from "@/lib/tenantOrigin";
import { AddUserForm, ChangePasswordForm } from "@/components/TeamForms";
import {
  saveSmtpSettings,
  saveServiceReminderSettings,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  saveSigningEmailTemplate,
  resetSigningEmailTemplate,
  previewSigningEmailTemplate,
  saveEmailHeaderStyle,
} from "@/app/actions/emails";
import {
  EMAIL_HEADER_STYLES,
  parseEmailHeaderStyle,
  SIGNING_EMAILS,
  SIGNING_EMAIL_KINDS,
  SIGNING_FIELD_HELP,
  isTextTemplate,
  parseStoredSigningTemplate,
  type SigningEmailKind,
} from "@/lib/signing/emailTemplates";
import { sanitizeEmailDoc, textToEmailDoc } from "@/lib/signing/emailDoc";
import { EmailTemplateEditor, SmsTemplateEditor } from "@/components/settings/EmailTemplateEditor";
import TestEmailButton from "@/components/TestEmailButton";
import ConfirmDelete from "@/components/ConfirmDelete";
import ClearSecret from "@/components/ClearSecret";
import ImportContactsForm from "@/components/ImportContactsForm";
import PushToggle from "@/components/PushToggle";
import SecurityPanel from "@/components/SecurityPanel";
import PasskeyManager from "@/components/PasskeyManager";
import OwnerUserControls from "@/components/OwnerUserControls";
import { saveSessionPolicy } from "@/app/actions/security";
import { saveImapSettings } from "@/app/actions/emails";
import { clearErrorLog } from "@/app/actions/ai";
import { basePrisma } from "@/lib/db";
import { REGIONAL_KEYS } from "@/lib/settings";
import { formatDate, formatDateTime, formatZAR, regionalFrom } from "@/lib/format";
import { DEFAULT_QUOTE_TERMS, quoteValidDays } from "@/lib/quoteExpiry";
import { ABSOLUTE_SESSION_HOURS } from "@/lib/session";
import { decryptValue } from "@/lib/settings";
import { PUSH_KINDS } from "@/lib/push";
import Link from "next/link";
import { getNextStepScheduling } from "@/lib/nextStepConfig";
import { saveNextStepScheduling } from "@/app/actions/settings";
import ProductsPage from "../products/page";
import { addStockLabel, removeStockLabel } from "@/app/actions/stock";
import { getStockLabels } from "@/lib/stockLabels";
import { SETTINGS_TABS, visibleSettingsGroups } from "@/lib/settings-navigation";
import { getUserPermissionList } from "@/lib/permissions";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import {
  SettingsIntegrationRow,
  SettingsOverview,
  SettingsWorkspace,
} from "@/components/settings-workspace";
import ProfileSettingsForms from "@/components/ProfileSettingsForms";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; section?: string; open?: string }>;
}) {
  const currentUser = await requireUser();
  // The WORKSPACE's owner — the tabs here configure this workspace, and every
  // action behind them now checks requireTenantOwner(). `role === "owner"` is the
  // platform owner, which a workspace's own owner never is.
  const isAdmin = await isTenantOwner();
  // The signature PREVIEW must render what the send path renders, or the screen
  // where you check your signature is the one screen that lies about it.
  const profile = await getCompanyProfile();
  // The preview must render what the send path renders, glyph URLs included.
  const signatureCompany = signatureCompanyFrom(profile, await tenantOrigin(await getActiveTenantId()));
  const enabled = await getEnabledModuleIds();
  const automotiveOn = enabled.has("automotive");
  const commerceOn = enabled.has("commerce");
  const marketingOn = enabled.has("marketing");
  // The tabs rendered on THIS page are owner-only apart from My Account. A
  // non-owner's nav still lists the settings pages their permissions open
  // (Pipeline, Checklists, Team & access…) — those live on their own routes.
  const visibleTabs = isAdmin
    ? SETTINGS_TABS
    : SETTINGS_TABS.filter((t) => t.key === "account");
  const visibleGroups = visibleSettingsGroups(
    { isOwner: isAdmin, isPlatformOwner: currentUser.role === "owner", permissions: await getUserPermissionList(currentUser) },
    enabled,
  );
  const { tab: rawTab, section, open } = await searchParams;
  // One message template, opened — linked from each automation on Settings →
  // Automatic jobs & messages ("see and edit what it sends").
  const openTemplate = open && (SIGNING_EMAIL_KINDS as string[]).includes(open) ? open : null;
  // Deep-linkable sections inside a tab. The account menu links straight to
  // "change password", and a <details> that arrives closed has not answered the
  // request — the person still has to find and open it.
  const requestedTab = rawTab ?? "";
  // The old single-pipeline stage editor that lived here was the second copy of
  // /settings/pipelines (gap audit, batch 6) — which does all it did plus multiple
  // pipelines and stage rules. Old links land there.
  if (requestedTab === "pipeline") redirect("/settings/pipelines");
  // Integrations are ONE page now (batch 6): this tab's credential forms and the
  // separate overrides page were two doors to the same thing. Query string kept
  // (the X OAuth callback reports its result on it).
  if (requestedTab === "integrations") {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries((await searchParams) as Record<string, string | undefined>)) {
      if (name !== "tab" && typeof value === "string") params.set(name, value);
    }
    const query = params.toString();
    redirect(`/settings/integrations${query ? `?${query}` : ""}`);
  }
  const tab = visibleTabs.some((t) => t.key === requestedTab)
    ? requestedTab
    : isAdmin
    ? "overview"
    : "account";

  // The team roster. `User` is a global model and this read had no filter at all,
  // so Settings → Team showed one workspace the name, email, role and 2FA state of
  // every person on the platform — and handed its owner the Manage controls for
  // them. Membership comes from `TenantMember`, via the ACTING workspace: the
  // background `listTenantStaff` skips that join while enforcement is dormant,
  // which is every environment today, and would have left this exactly as global.
  //
  // Disabled members are kept, because this is an administration surface and
  // Settings → Access needs to reactivate them — hence the membership-only list
  // rather than the assignable-staff one.
  const memberIds = await actingTenantMemberIds();
  const [users, settings, templates] = await Promise.all([
    prisma.user.findMany({
      where: memberIds === null ? {} : { id: { in: memberIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.appSetting.findMany(),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
  ]);
  const stockLabels = await getStockLabels();
  const nextStepScheduling = await getNextStepScheduling();
  const setting = (key: string) => {
    const raw = settings.find((s) => s.key === key)?.value ?? "";
    try {
      return decryptValue(raw);
    } catch {
      return ""; // encrypted value, key unavailable in this environment
    }
  };
  const regional = regionalFrom(
    Object.fromEntries(Object.entries(REGIONAL_KEYS).map(([field, key]) => [field, setting(key)])),
  );
  // The signing emails' edited copies, read by EXPLICIT tenant — the same key the
  // send path reads by the signature request's tenantId (lib/signing/signingEmail.ts).
  const signingTenantId = isAdmin && tab === "email" ? await getActiveTenantId() : null;
  const signingOverrides = signingTenantId
    ? await basePrisma.appSetting.findMany({
        where: {
          tenantId: signingTenantId,
          key: { in: [...SIGNING_EMAIL_KINDS.map((k) => SIGNING_EMAILS[k].settingKey), "EMAIL_HEADER_STYLE"] },
        },
        select: { key: true, value: true },
      })
    : [];
  const signingTemplate = (kind: SigningEmailKind) =>
    parseStoredSigningTemplate(signingOverrides.find((s) => s.key === SIGNING_EMAILS[kind].settingKey)?.value, kind);
  const emailHeaderStyle = parseEmailHeaderStyle(signingOverrides.find((s) => s.key === "EMAIL_HEADER_STYLE")?.value);
  const isOwner = isAdmin;
  // The System Log is TENANT-SCOPED. `basePrisma` bypasses the tenant guard, so the
  // unfiltered read this replaced handed every tenant owner every other tenant's
  // error messages, stack traces and context — the most revealing rows in the
  // database. Errors with no tenant (system/cron work, and everything logged before
  // ErrorLog gained the column) stay out of here too: a tenant cannot tell whose
  // they are. Unattributed and cross-tenant errors are the platform console's job.
  //
  // A session with no resolvable tenant therefore sees nothing rather than
  // everything. That is the same condition under which `logError` records
  // `tenantId: null`, so read and write agree; signing in again mints the claim.
  const logTenantId = isAdmin && tab === "system" ? await getActiveTenantId() : null;
  const errorLogs = logTenantId
    ? await basePrisma.errorLog.findMany({
        where: { tenantId: logTenantId },
        orderBy: { createdAt: "desc" },
        take: 500,
      })
    : [];
  // Collapse identical errors (same scope + message) into one row with an
  // occurrence count and first/last-seen, so a crash-loop is one line, not 200.
  const errorGroups = (() => {
    const map = new Map<
      string,
      { scope: string; message: string; count: number; first: Date; last: Date; stack: string | null; context: string | null }
    >();
    // Signature groups near-identical crash-loops (same opening) while keeping
    // genuinely different errors apart (e.g. two distinct prisma calls).
    const signature = (msg: string) => msg.replace(/\s+/g, " ").trim().slice(0, 100);
    for (const e of errorLogs) {
      const key = `${e.scope}::${signature(e.message)}`;
      const g = map.get(key);
      if (!g) {
        map.set(key, { scope: e.scope, message: e.message, count: 1, first: e.createdAt, last: e.createdAt, stack: e.stack, context: e.context });
      } else {
        g.count += 1;
        if (e.createdAt < g.first) g.first = e.createdAt;
        // errorLogs is newest-first, so the first-seen entry per key holds the latest stack
      }
    }
    return [...map.values()].sort((a, b) => b.last.getTime() - a.last.getTime());
  })();
  // This server-rendered route takes one request-time snapshot for the 24-hour metric.
  // eslint-disable-next-line react-hooks/purity
  const oneDayAgo = Date.now() - 86_400_000;
  const errorStats = {
    total: errorLogs.length,
    distinct: errorGroups.length,
    last24h: errorLogs.filter((e) => e.createdAt.getTime() > oneDayAgo).length,
  };
  const myPasskeys = tab === "account"
    ? await prisma.passkey.findMany({
        where: { userId: currentUser.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, nickname: true, createdAt: true, lastUsedAt: true },
      })
    : [];

  return (
    <SettingsWorkspace
      current={tab}
      title="Settings"
      description="Configure your workspace, customer channels, operational policies and security from one searchable place."
      groups={visibleGroups}
    >
      {tab === "overview" && <SettingsOverview groups={visibleGroups} />}

      {tab === "account" && (
        // The modal is max-w-5xl; capping the content at 3xl left a dead strip down
        // the right of every account screen. Fields stay readable because they sit
        // in columns, not because the container is narrow.
        <div className="max-w-5xl space-y-6">
          <ProfileSettingsForms
            name={currentUser.name}
            email={currentUser.email}
            mobile={currentUser.mobile}
            jobTitle={currentUser.jobTitle}
            role={isOwner ? "Owner" : "Member"}
            createdAt={currentUser.createdAt.toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}
            hasAvatar={Boolean(currentUser.avatarRef)}
            avatarVersion={currentUser.avatarUpdatedAt?.toISOString() ?? null}
          />

          <div className="card p-0 divide-y divide-border/50">
            <details id="password" open={section === "password"}>
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
                <span className="text-sm font-medium flex items-center gap-2">
                  Passkeys
                  {myPasskeys.length > 0 ? (
                    <span className="badge bg-emerald-500/15 text-emerald-300">
                      {myPasskeys.length}
                    </span>
                  ) : (
                    <span className="badge bg-muted text-muted-foreground">None</span>
                  )}
                </span>
                <span className="btn-secondary btn-sm">
                  {myPasskeys.length > 0 ? "Manage" : "Set up"}
                </span>
              </summary>
              <div className="px-5 pb-5">
                <PasskeyManager
                  passkeys={myPasskeys.map((p) => ({
                    id: p.id,
                    nickname: p.nickname,
                    createdAt: p.createdAt.toISOString(),
                    lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
                  }))}
                />
              </div>
            </details>

            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium">Push notifications</span>
                <span className="btn-secondary btn-sm">Manage</span>
              </summary>
              <div className="px-5 pb-5">
                <p className="text-xs text-muted-foreground mb-3">
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
                  dangerouslySetInnerHTML={{ __html: buildSignature(currentUser, signatureCompany) }}
                />
                <SaveForm success="Profile saved" resetOnSuccess={false} action={saveMyProfile} className="space-y-3 max-w-md">
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
                  <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                </SaveForm>
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
                          <span className="text-xs text-muted-foreground ml-1.5">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          u.role === "owner"
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground"
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
                        {/* A platform owner's account is the platform's to manage (security.ts). */}
                        {u.id !== currentUser.id && (currentUser.role === "owner" || u.role !== "owner") && (
                          <OwnerUserControls
                            userId={u.id}
                            name={u.name}
                            role={u.role as "owner" | "member"}
                            has2fa={Boolean(u.totpEnabledAt || u.emailOtpEnabled)}
                            canChangeRole={currentUser.role === "owner"}
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
            <div className="card p-0 divide-y divide-border/50">
              <details>
                <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                  <span className="text-sm font-medium">Add a team member</span>
                  <span className="btn-secondary btn-sm">+ Add</span>
                </summary>
                <div className="px-5 pb-5 max-w-md">
                  <AddUserForm />
                </div>
              </details>

              <SaveForm
                action={saveSessionPolicy}
                success="Sign-out policy saved"
                resetOnSuccess={false}
                className="flex items-center justify-between gap-4 px-5 py-4 flex-wrap"
              >
                <div>
                  <p className="text-sm font-medium">Auto sign-out after inactivity</p>
                  <p className="text-xs text-muted-foreground">
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
                  <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                </div>
              </SaveForm>
            </div>
          )}
        </div>
      )}

      {tab === "notifications" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-border/50">
            <details>
              <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                <span className="text-sm font-medium">Push on this device</span>
                <span className="btn-secondary btn-sm">Manage</span>
              </summary>
              <div className="px-5 pb-5">
                <p className="text-xs text-muted-foreground mb-3">
                  Each phone/computer opts in separately. Install the app on your phone for
                  lock-screen notifications.
                </p>
                <PushToggle />
              </div>
            </details>

            <SaveForm success="Notification preferences saved" resetOnSuccess={false} action={saveNotificationPrefs} className="px-5 py-4">
              <p className="text-sm font-medium">What sends a notification</p>
              <p className="text-xs text-muted-foreground mb-3">
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
                      <span className="block text-xs text-muted-foreground">{k.desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              <SaveButton className="btn-primary btn-sm mt-4">Save</SaveButton>
            </SaveForm>
          </div>
        </div>
      )}

      {tab === "system" && (
        <div className="w-full space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-muted-foreground max-w-2xl">
              System errors from syncs, webhooks, email/SMS and unhandled crashes, for this
              workspace only. Identical errors are grouped. Auto-purged after 30 days; a push
              fires on the first error in any 30-minute window.
            </p>
            {errorLogs.length > 0 && (
              <SaveForm success="System log cleared" resetOnSuccess={false} action={clearErrorLog}>
                <SaveButton className="btn-secondary btn-sm">Clear log</SaveButton>
              </SaveForm>
            )}
          </div>

          {!logTenantId && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-200/90">
              This sign-in has no workspace attached, so no errors can be shown — the log is
              scoped to one workspace and showing you another&apos;s would be worse than showing
              none. Sign out and back in to attach it.
            </p>
          )}

          {errorLogs.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <div className="card py-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Events</p>
                <p className="text-2xl font-semibold tracking-[-0.03em] mt-0.5">{errorStats.total}</p>
              </div>
              <div className="card py-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Distinct issues</p>
                <p className="text-2xl font-semibold tracking-[-0.03em] mt-0.5">{errorStats.distinct}</p>
              </div>
              <div className="card py-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Last 24h</p>
                <p className={`text-2xl font-semibold tracking-[-0.03em] mt-0.5 ${errorStats.last24h > 0 ? "text-amber-300" : ""}`}>
                  {errorStats.last24h}
                </p>
              </div>
            </div>
          )}

          <div className="card p-0 overflow-x-auto">
            {errorGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground p-5">No errors on record. 🎉</p>
            ) : (
              <table className="table-base min-w-[720px]">
                <thead>
                  <tr>
                    <th className="w-32">Scope</th>
                    <th>Error</th>
                    <th className="text-right w-20">Count</th>
                    <th className="w-40">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {errorGroups.map((g) => (
                    <tr key={`${g.scope}::${g.message}`} className="align-top">
                      <td className="w-32">
                        <span className="badge bg-red-500/15 text-red-300">{g.scope}</span>
                      </td>
                      <td>
                        <details>
                          <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-sm text-foreground hover:text-white">
                            {g.message}
                          </summary>
                          <div className="mt-2 space-y-1">
                            <p className="text-[11px] text-muted-foreground">
                              {g.count > 1
                                ? `${g.count} occurrences · first ${formatDateTime(g.first)} · last ${formatDateTime(g.last)}`
                                : formatDateTime(g.last)}
                            </p>
                            {g.context && <p className="text-xs text-muted-foreground">{g.context}</p>}
                            {g.stack && (
                              <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto rounded bg-black/20 p-2">
                                {g.stack}
                              </pre>
                            )}
                          </div>
                        </details>
                      </td>
                      <td className="text-right w-20">
                        {g.count > 1 ? (
                          <span className="badge bg-amber-500/15 text-amber-300 tabular-nums">×{g.count}</span>
                        ) : (
                          <span className="text-muted-foreground tabular-nums">1</span>
                        )}
                      </td>
                      <td className="w-40 text-[11px] text-muted-foreground whitespace-nowrap">
                        {relTime(g.last)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === "email" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-border/50">
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
              <p className="text-xs text-muted-foreground mb-4">
                Used for all outgoing email. Works with any SMTP provider (your denagocpt.co.za
                mailbox, Google Workspace, Resend, SendGrid).
              </p>
              <SaveForm success="Outgoing mail settings saved" resetOnSuccess={false} action={saveSmtpSettings} className="grid md:grid-cols-2 gap-3 mb-3">
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
                    <label htmlFor="secure" className="text-sm text-muted-foreground">
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
                  {/* Never echo the stored secret — blank means "keep it" (see saveSmtpSettings). Clear = no-password config. */}
                  <div className="flex gap-2">
                    <input name="pass" type="password" autoComplete="new-password" className="input flex-1" placeholder={setting("SMTP_PASS") ? "•••••••• saved — leave blank to keep" : ""} />
                    {setting("SMTP_PASS") ? <ClearSecret settingKey="SMTP_PASS" label="SMTP password" /> : null}
                  </div>
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
                  <SaveButton className="btn-primary">Save email settings</SaveButton>
                </div>
              </SaveForm>
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
              <p className="text-xs text-muted-foreground mb-4">
                Customer replies land on their record automatically (checked every 30 minutes,
                read-only — nothing is moved or marked in the mailbox). Unknown senders are left
                alone. Usually the same details as SMTP with port 993.
              </p>
              <SaveForm success="Incoming mail settings saved" resetOnSuccess={false} action={saveImapSettings} className="grid md:grid-cols-2 gap-3">
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
                    <label htmlFor="imap-secure" className="text-sm text-muted-foreground">SSL</label>
                  </div>
                </div>
                <div>
                  <label className="label">Username</label>
                  <input name="user" className="input" defaultValue={setting("IMAP_USER")} placeholder="sales@denagocpt.co.za" />
                </div>
                <div>
                  <label className="label">Password</label>
                  {/* Never echo the stored secret — blank means "keep it" (see saveImapSettings). Clear = no-password config. */}
                  <div className="flex gap-2">
                    <input name="pass" type="password" autoComplete="new-password" className="input flex-1" placeholder={setting("IMAP_PASS") ? "•••••••• saved — leave blank to keep" : ""} />
                    {setting("IMAP_PASS") ? <ClearSecret settingKey="IMAP_PASS" label="IMAP password" /> : null}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <SaveButton className="btn-primary">Save incoming email</SaveButton>
                </div>
              </SaveForm>
            </Row>

            {automotiveOn && (
            <Row
              title="Service reminders to customers"
              status={
                setting("SERVICE_REMINDER_ENABLED") === "true" ? (
                  <span className="badge bg-emerald-500/15 text-emerald-300">On</span>
                ) : (
                  <span className="badge bg-muted text-muted-foreground">Off</span>
                )
              }
            >
              <p className="text-xs text-muted-foreground mb-4">
                Customers whose vehicle is due for a service get one automatic email per
                due-cycle. Placeholders: <code>{"{{first_name}}"}</code>,{" "}
                <code>{"{{model}}"}</code>, <code>{"{{due_date}}"}</code>,{" "}
                <code>{"{{due_km}}"}</code>, <code>{"{{current_km}}"}</code>.
              </p>
              <SaveForm success="Service reminder settings saved" resetOnSuccess={false} action={saveServiceReminderSettings} className="flex items-end gap-3 flex-wrap">
                <div className="flex items-center gap-2 pb-2">
                  <input
                    type="checkbox"
                    name="enabled"
                    id="sr-enabled"
                    defaultChecked={setting("SERVICE_REMINDER_ENABLED") === "true"}
                    className="h-4 w-4"
                  />
                  <label htmlFor="sr-enabled" className="text-sm text-muted-foreground">
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
                <SaveButton className="btn-primary">Save</SaveButton>
              </SaveForm>
            </Row>
            )}

            {/* The "Lifecycle journeys" toggles (LIFECYCLE_ANNIVERSARY_ENABLED /
                LIFECYCLE_WINBACK_ENABLED) were removed here. They drove a
                hardcoded second copy of anniversary and win-back email — the
                journey scheduler reimplements both field for field — and with
                both switched on a customer got two of each, because the two
                dedupe stores could not see one another. The migration
                20260802120000_retire_automation_rules turns whichever toggles
                were on into real journeys on /journeys, where the copy is
                editable. */}

            <Row
              title="Email templates"
              status={
                <span className="badge bg-muted text-muted-foreground">{templates.length}</span>
              }
              action="Manage"
            >
              <div className="mb-5">
                <div className="text-sm font-semibold mb-1">Messages your customers receive</div>
                <p className="text-xs text-muted-foreground mb-3">
                  Every email and text the system sends a customer on its own — signing, quotes, codes, reminders,
                  recalls, review requests and surveys. Your logo, brand colour and company details are added for you;
                  each preview shows exactly what the customer receives.
                </p>
                <SaveForm success="Email header saved" resetOnSuccess={false} action={saveEmailHeaderStyle} className="mb-3 flex flex-wrap items-end gap-2">
                  <div>
                    <label className="label">Header background</label>
                    <select name="headerStyle" className="input" defaultValue={emailHeaderStyle}>
                      {Object.entries(EMAIL_HEADER_STYLES).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <SaveButton className="btn-secondary btn-sm">Save</SaveButton>
                  <span className="text-xs text-muted-foreground basis-full">
                    Pick Dark or Brand colour if your logo is drawn in white.
                  </span>
                </SaveForm>
                {[...new Set(SIGNING_EMAIL_KINDS.map((k) => SIGNING_EMAILS[k].group))].map((group) => (
                <div key={group} className="mb-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{group}</div>
                <div className="space-y-3">
                  {SIGNING_EMAIL_KINDS.filter((k) => SIGNING_EMAILS[k].group === group).map((kind) => {
                    const def = SIGNING_EMAILS[kind];
                    const saved = signingTemplate(kind);
                    return (
                      // Linked from Settings → Automatic jobs & messages: ?open=<kind> opens this one.
                      <details key={kind} id={`template-${kind}`} open={openTemplate === kind} className="rounded-lg border border-border bg-muted/40 scroll-mt-24">
                        <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium flex items-center gap-2">
                          {def.label}
                          <span className="badge bg-muted text-muted-foreground">{def.channel === "sms" ? "SMS" : def.channel === "whatsapp" ? "WhatsApp" : "Email"}</span>
                          <span className="badge bg-muted text-muted-foreground">{saved ? "Customised" : "Default"}</span>
                        </summary>
                        <div className="p-4 pt-1 space-y-2">
                          <p className="text-xs text-muted-foreground">{def.description}</p>
                          <SaveForm
                            // Remount after a reset so the fields show the default again.
                            key={saved ? "custom" : "default"}
                            success={`${def.label} saved`}
                            resetOnSuccess={false}
                            action={saveSigningEmailTemplate.bind(null, kind)}
                            className="space-y-2"
                          >
                            {isTextTemplate(def) ? (
                              <SmsTemplateEditor
                                initialBody={saved?.body ?? def.body}
                                fields={def.fields}
                                fieldHelp={SIGNING_FIELD_HELP}
                                requiredField={def.action}
                                preview={previewSigningEmailTemplate.bind(null, kind)}
                                whatsapp={def.channel === "whatsapp"}
                              />
                            ) : (
                              <EmailTemplateEditor
                                initialSubject={saved?.subject ?? def.subject}
                                initialDoc={
                                  (saved?.doc ? sanitizeEmailDoc(saved.doc, def.fields) : null) ??
                                  textToEmailDoc(saved?.body ?? def.body, def.fields)
                                }
                                fields={def.fields}
                                fieldHelp={SIGNING_FIELD_HELP}
                                requiredField={def.action}
                                preview={previewSigningEmailTemplate.bind(null, kind)}
                                refreshKey={emailHeaderStyle}
                              />
                            )}
                            <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                          </SaveForm>
                          {saved && (
                            <SaveForm success="Reset to default" action={resetSigningEmailTemplate.bind(null, kind)}>
                              <SaveButton className="btn-secondary btn-sm">Reset to default</SaveButton>
                            </SaveForm>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </div>
                </div>
                ))}
              </div>
              <div className="text-sm font-semibold mb-1">Your templates</div>
              <p className="text-xs text-muted-foreground mb-2">
                For campaigns, journeys and service reminders. Placeholders: <code>{"{{name}}"}</code>,{" "}
                <code>{"{{first_name}}"}</code>, <code>{"{{model}}"}</code>, <code>{"{{color}}"}</code>,{" "}
                <code>{"{{value}}"}</code>, <code>{"{{user_name}}"}</code> — filled from the lead/contact when sending.
              </p>
              <div className="space-y-3 mb-4">
                {templates.map((t) => (
                  <details key={t.id} className="rounded-lg border border-border bg-muted/40">
                    <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium">
                      {t.name}
                    </summary>
                    <div className="p-4 pt-1 space-y-2">
                      <SaveForm resetOnSuccess={false} action={updateTemplate.bind(null, t.id)} className="space-y-2">
                        <input name="name" className="input" defaultValue={t.name} required />
                        <input name="subject" className="input" defaultValue={t.subject} required />
                        <textarea name="body" className="input" rows={5} defaultValue={t.body} required />
                        <SaveButton className="btn-primary btn-sm">Save template</SaveButton>
                      </SaveForm>
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
              <details className="rounded-lg border border-border bg-muted/40">
                <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium">
                  + New template
                </summary>
                {/* A CREATE form: it must clear, or the finished template sits there
                    ready to be submitted again by an extra click. */}
                <SaveForm success="Template created" action={createTemplate} className="p-4 pt-1 space-y-2">
                  <input name="name" className="input" placeholder="Template name (e.g. New lead welcome)" required />
                  <input name="subject" className="input" placeholder="Subject — e.g. Your {{model}} enquiry" required />
                  <textarea
                    name="body"
                    className="input"
                    rows={5}
                    required
                    placeholder={"Hi {{first_name}},\n\nThanks for your interest in the {{model}}…\n\n{{user_name}}\nDenago Cape Town · 073 789 3438"}
                  />
                  <SaveButton className="btn-primary btn-sm">Create template</SaveButton>
                </SaveForm>
              </details>
            </Row>
          </div>
        </div>
      )}

      {tab === "import" && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-border/50">
            <Row title="Import contacts from CSV" action="Import">
              <p className="text-xs text-muted-foreground mb-4">
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
          <div className="card p-0 divide-y divide-border/50">
            <Row
              title="Quote defaults"
              status={
                <span className="badge bg-muted text-muted-foreground">
                  valid {quoteValidDays(setting("QUOTE_VALID_DAYS"))} days
                </span>
              }
              action="Edit"
            >
              <p className="text-xs text-muted-foreground mb-4">
                Applied to new quotes; each quote can still be adjusted individually.
              </p>
              <SaveForm success="Quote defaults saved" resetOnSuccess={false} action={saveQuoteDefaults} className="space-y-4 max-w-xl">
                <div>
                  <label className="label">Valid for (days)</label>
                  <input
                    name="validDays"
                    type="number"
                    min={1}
                    className="input w-32"
                    defaultValue={quoteValidDays(setting("QUOTE_VALID_DAYS"))}
                  />
                </div>
                <div>
                  <label className="label">Default terms (one bullet per line)</label>
                  <textarea
                    name="terms"
                    className="input"
                    rows={6}
                    defaultValue={setting("QUOTE_TERMS") || DEFAULT_QUOTE_TERMS}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Each line becomes its own bullet point on the printed quote.
                  </p>
                </div>
                <SaveButton className="btn-primary">Save quote defaults</SaveButton>
              </SaveForm>
            </Row>
            <Row
              title="Tax, currency & time zone"
              status={
                <span className="badge bg-muted text-muted-foreground">
                  VAT {regional.vatRatePct}% · {regional.currency}
                </span>
              }
              action="Edit"
            >
              <p className="text-xs text-muted-foreground mb-4">
                Used on quotes, invoices, agreements and other customer documents. A new VAT rate applies to
                new quote lines only — quotes already issued keep the rate they were issued with.
              </p>
              <SaveForm success="Tax & currency saved" resetOnSuccess={false} action={saveRegionalSettings} className="space-y-4 max-w-xl">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="regional-vat">VAT rate (%)</label>
                    <input id="regional-vat" name="vatRatePct" type="number" min={0} max={100} step="0.01" required className="input w-32" defaultValue={regional.vatRatePct} />
                  </div>
                  <div>
                    <label className="label" htmlFor="regional-currency">Currency code</label>
                    <input id="regional-currency" name="currency" required maxLength={3} className="input w-32 uppercase" defaultValue={regional.currency} />
                    <p className="text-xs text-muted-foreground mt-1">Three letters, e.g. ZAR, USD, EUR.</p>
                  </div>
                  <div>
                    <label className="label" htmlFor="regional-locale">Number &amp; date format</label>
                    <input id="regional-locale" name="locale" required className="input" defaultValue={regional.locale} />
                    <p className="text-xs text-muted-foreground mt-1">
                      e.g. en-ZA, en-GB. Currently prints {formatZAR(123456, regional)} and {formatDate(new Date(), regional)}.
                    </p>
                  </div>
                  <div>
                    <label className="label" htmlFor="regional-tz">Time zone</label>
                    <input id="regional-tz" name="timeZone" required list="regional-tz-options" className="input" defaultValue={regional.timeZone} />
                    <datalist id="regional-tz-options">
                      {Intl.supportedValuesOf("timeZone").map((zone) => (
                        <option key={zone} value={zone} />
                      ))}
                    </datalist>
                  </div>
                </div>
                <SaveButton className="btn-primary">Save tax &amp; currency</SaveButton>
              </SaveForm>
            </Row>
          </div>
        </div>
      )}

      {tab === "workshop" && automotiveOn && (
        <div className="max-w-3xl">
          <div className="card p-0 divide-y divide-border/50">
            <Row
              title="Online booking slots"
              status={
                <span className="badge bg-muted text-muted-foreground">
                  {(setting("BOOKING_SLOT_TIMES") || "08:00,10:00,12:00,14:00").split(",").length}{" "}
                  per day
                </span>
              }
              action="Edit"
            >
              <p className="text-xs text-muted-foreground mb-4">
                Customers booking a service on denagocpt.co.za can only pick these slots. A slot
                disappears from the website the moment it&apos;s taken.
              </p>
              <SaveForm success="Workshop settings saved" resetOnSuccess={false} action={saveWorkshopSettings} className="space-y-4 max-w-xl">
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
                      <label key={val} className="flex items-center gap-1.5 text-sm text-muted-foreground">
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
                <SaveButton className="btn-primary">Save workshop settings</SaveButton>
              </SaveForm>
            </Row>
          </div>
        </div>
      )}

      {/* This tab used to render the whole /automations page inline. That page is
          now a redirect (the AutomationRule engine is retired in favour of
          journeys), and a redirect cannot be embedded — so the one setting the
          page owned that is NOT a rule, next-step scheduling, lives here now.
          It still has a reader: the journey create_activity step. */}
      {tab === "automations" && marketingOn && (
        <div className="max-w-3xl space-y-4">
          <Row
            title="Automation journeys"
            status={
              <Link href="/journeys" className="badge bg-primary/15 text-primary hover:underline">
                Open journeys
              </Link>
            }
          >
            <p className="text-xs text-muted-foreground">
              Triggers, conditions and actions all live in the journey builder — versioned,
              multi-step, with waits, branches and a full run history.
            </p>
          </Row>

          <Row title="Next-step scheduling">
            <p className="text-xs text-muted-foreground mb-4">
              Controls when a journey&apos;s auto-created follow-up task is due.
            </p>
            <SaveForm
              success="Next-step scheduling saved"
              resetOnSuccess={false}
              action={saveNextStepScheduling}
              className="grid gap-4"
            >
              <div>
                <label className="label" htmlFor="nss-hour">Work-hour for follow-ups</label>
                <select
                  id="nss-hour"
                  name="hour"
                  className="input"
                  defaultValue={String(nextStepScheduling.hour)}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
                  ))}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  name="skipWeekends"
                  defaultChecked={nextStepScheduling.skipWeekends}
                  className="h-4 w-4"
                />
                Skip weekends (roll to Monday)
              </label>
              <SaveButton className="btn-primary">Save scheduling</SaveButton>
            </SaveForm>
          </Row>
        </div>
      )}
      {tab === "stock" && commerceOn && (
        <div className="max-w-3xl space-y-4">
          <div className="card">
            <h2 className="font-semibold mb-1">Stock labels</h2>
            <p className="text-xs text-muted-foreground mb-4">
              Organisational labels are <b>separate</b> from a unit&apos;s lifecycle status (incoming →
              delivered). Use them to flag demo units, showroom stock, consignment, management holds and
              the like. Removing a label clears it from any units carrying it.
            </p>
            {stockLabels.length === 0 ? (
              <p className="text-sm text-muted-foreground">No labels yet — add one below.</p>
            ) : (
              <ul className="divide-y divide-border/50">
                {stockLabels.map((l) => (
                  <li key={l.slug} className="flex items-center gap-2 py-2">
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${l.color}22`, color: l.color }}>{l.label}</span>
                    <SaveForm success="Label removed" resetOnSuccess={false} action={removeStockLabel.bind(null, l.slug)} className="ml-auto">
                      <SaveButton className="btn-danger btn-sm">Remove</SaveButton>
                    </SaveForm>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <SaveForm success="Label added" action={addStockLabel} className="card space-y-3">
            <h2 className="font-semibold">Add a label</h2>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <div>
                <label className="label">Name</label>
                <input name="label" className="input" placeholder="e.g. Demo unit, Consignment, Management hold" required />
              </div>
              <div>
                <label className="label">Colour</label>
                <input name="color" type="color" defaultValue="#8b5cf6" className="input h-10 w-16 p-1" />
              </div>
            </div>
            <SaveButton className="btn-primary">Add label</SaveButton>
          </SaveForm>
        </div>
      )}

      {tab === "products" && commerceOn && <ProductsPage />}
    </SettingsWorkspace>
  );
}

/** Compact "3h ago" style relative time for the system log. */
function relTime(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
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
    <SettingsIntegrationRow title={title} status={status} action={action}>{children}</SettingsIntegrationRow>
  );
}
