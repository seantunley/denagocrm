import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  createStage,
  renameStage,
  moveStage,
  deleteStage,
  saveSetting,
  regenerateSetting,
} from "@/app/actions/settings";
import { AddUserForm, ChangePasswordForm } from "@/components/TeamForms";
import {
  saveSmtpSettings,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} from "@/app/actions/emails";
import TestEmailButton from "@/components/TestEmailButton";
import { formatDate } from "@/lib/format";

const TABS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "team", label: "Team" },
  { key: "email", label: "Email" },
  { key: "integrations", label: "Integrations" },
] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireUser();
  const { tab: rawTab } = await searchParams;
  const tab = TABS.some((t) => t.key === rawTab) ? rawTab : "pipeline";

  const [stages, users, settings, templates] = await Promise.all([
    prisma.pipelineStage.findMany({
      orderBy: { order: "asc" },
      include: { _count: { select: { leads: true } } },
    }),
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.appSetting.findMany(),
    prisma.emailTemplate.findMany({ orderBy: { name: "asc" } }),
  ]);
  const setting = (key: string) => settings.find((s) => s.key === key)?.value ?? "";

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="flex gap-1 border-b border-slate-800 overflow-x-auto">
        {TABS.map((t) => (
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
                <form action={deleteStage.bind(null, s.id)}>
                  <button
                    className="btn-danger btn-sm"
                    disabled={s._count.leads > 0}
                    title={s._count.leads > 0 ? "Stage still has leads" : "Delete stage"}
                  >
                    ✕
                  </button>
                </form>
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

      {tab === "team" && (
        <div className="grid md:grid-cols-2 gap-6 items-start">
          <div className="card">
            <h2 className="font-semibold mb-4">Team members</h2>
            <ul className="divide-y divide-slate-800 mb-4">
              {users.map((u) => (
                <li key={u.id} className="py-2">
                  <p className="text-sm font-medium">{u.name}</p>
                  <p className="text-xs text-slate-400">
                    {u.email} · joined {formatDate(u.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
            <AddUserForm />
          </div>

          <div className="card">
            <h2 className="font-semibold mb-4">Change my password</h2>
            <ChangePasswordForm />
          </div>
        </div>
      )}

      {tab === "email" && (
        <>
          <div className="card">
            <h2 className="font-semibold mb-1">Email (SMTP)</h2>
            <p className="text-xs text-slate-400 mb-4">
              Used for sending emails from leads/contacts and by automations. Works with any SMTP
              provider (e.g. your denagocpt.co.za mailbox, Google Workspace, Resend, SendGrid).
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
          </div>

          <div className="card">
            <h2 className="font-semibold mb-1">Email templates</h2>
            <p className="text-xs text-slate-400 mb-4">
              Placeholders: <code>{"{{name}}"}</code>, <code>{"{{first_name}}"}</code>,{" "}
              <code>{"{{model}}"}</code>, <code>{"{{color}}"}</code>, <code>{"{{value}}"}</code>,{" "}
              <code>{"{{user_name}}"}</code> — filled from the lead/contact when sending.
            </p>
            <div className="space-y-4 mb-5">
              {templates.map((t) => (
                <details key={t.id} className="rounded-lg border border-slate-800 bg-slate-800/40">
                  <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium flex items-center justify-between">
                    {t.name}
                  </summary>
                  <div className="p-4 pt-1 space-y-2">
                    <form action={updateTemplate.bind(null, t.id)} className="space-y-2">
                      <input name="name" className="input" defaultValue={t.name} required />
                      <input name="subject" className="input" defaultValue={t.subject} required />
                      <textarea name="body" className="input" rows={5} defaultValue={t.body} required />
                      <div className="flex gap-2">
                        <button className="btn-primary btn-sm">Save template</button>
                      </div>
                    </form>
                    <form action={deleteTemplate.bind(null, t.id)}>
                      <button className="btn-danger btn-sm">Delete</button>
                    </form>
                  </div>
                </details>
              ))}
            </div>
            <form action={createTemplate} className="rounded-lg bg-slate-800/40 p-4 border border-slate-800 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">New template</p>
              <input name="name" className="input" placeholder="Template name (e.g. New lead welcome)" required />
              <input name="subject" className="input" placeholder="Subject — e.g. Your {{model}} enquiry" required />
              <textarea
                name="body"
                className="input"
                rows={5}
                required
                placeholder={"Hi {{first_name}},\n\nThanks for your interest in the {{model}}…\n\n{{user_name}}\nDenago Cape Town · 081 515 8319"}
              />
              <button className="btn-primary btn-sm">Create template</button>
            </form>
          </div>
        </>
      )}

      {tab === "integrations" && (
        <>
          <div className="card">
            <h2 className="font-semibold mb-1">Facebook / Instagram Lead Ads</h2>
            <p className="text-xs text-slate-400 mb-4">
              In your Meta app, subscribe the webhook below to the <b>leadgen</b> field of your
              Facebook Page, using the verify token. Then paste a Page Access Token with{" "}
              <code>leads_retrieval</code> permission.
            </p>
            <div className="space-y-3">
              <div>
                <label className="label">Webhook callback URL</label>
                <code className="block text-sm bg-slate-800 rounded-lg px-3 py-2">
                  https://&lt;your-domain&gt;/api/webhooks/meta
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
                  <label className="label">Page access token</label>
                  <input
                    name="value"
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
                  <label className="label">App secret (recommended — verifies webhook signatures)</label>
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
          </div>

          <div className="card">
            <h2 className="font-semibold mb-1">Website lead intake API</h2>
            <p className="text-xs text-slate-400 mb-4">
              POST leads from your website or landing pages. Include the API key in the{" "}
              <code>X-Api-Key</code> header. Supported fields: name (required), email, phone,
              message, model, color, source.
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
              <div>
                <label className="label">Example</label>
                <pre className="text-xs bg-slate-950 text-slate-200 rounded-lg px-3 py-2 overflow-x-auto">{`curl -X POST https://<your-domain>/api/intake \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: ${setting("INTAKE_API_KEY") || "<key>"}" \\
  -d '{"name":"Jane Doe","email":"jane@example.com","phone":"0821234567","model":"Denago EV Rover XL","color":"Lava","message":"Interested in a demo drive"}'`}</pre>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
