import { Plus, ShieldAlert, KeyRound, LogOut, Trash2 } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platformAuth";
import { formatDateTime } from "@/lib/format";
import ModalTrigger from "@/components/Modal";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import {
  createPlatformAdminAction,
  setPlatformAdminDisabledAction,
  deletePlatformAdminAction,
  resetPlatformAdminPasswordAction,
  revokePlatformAdminSessionsAction,
} from "@/app/actions/platformAdmins";
import ChangeOwnPasswordForm from "./ChangeOwnPasswordForm";
import TwoFactorPanel from "./TwoFactorPanel";

export const dynamic = "force-dynamic";

export default async function PlatformAdminsPage() {
  // Defence-in-depth: the (console) layout gates this route group, but re-check so
  // the queries below can never run without a platform session.
  const me = await requirePlatformAdmin();
  const myTotp = await basePrisma.platformAdmin.findUnique({
    where: { id: me.id },
    select: { totpEnabledAt: true },
  });

  const admins = await basePrisma.platformAdmin.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      disabledAt: true,
      lastLoginAt: true,
      passwordChangedAt: true,
      createdAt: true,
      _count: { select: { sessions: { where: { revokedAt: null } } } },
    },
  });

  const activeCount = admins.filter((a) => !a.disabledAt).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">Platform admins</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Accounts that can administer every tenant. Entirely separate from CRM users —
            these have no access to any tenant&apos;s CRM.
          </p>
        </div>
        <ModalTrigger
          label={<><Plus className="size-4" />Add admin</>}
          title="Add platform admin"
          buttonClass="btn-primary btn-sm inline-flex items-center gap-1.5"
        >
          <SaveForm action={createPlatformAdminAction} success="Platform admin created" className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input name="name" className="input" required autoFocus placeholder="Full name" />
            </div>
            <div>
              <label className="label">Email</label>
              <input name="email" type="email" className="input" required placeholder="ops@example.com" />
              <p className="mt-1 text-xs text-muted-foreground">
                Used only to sign in here. It does not create a CRM user.
              </p>
            </div>
            <div>
              <label className="label">Password</label>
              <input name="password" type="password" className="input" required minLength={12} />
              <p className="mt-1 text-xs text-muted-foreground">
                At least 12 characters, including letters and numbers.
              </p>
            </div>
            <SaveButton pendingLabel="Creating…" className="btn-primary w-full">
              Create admin
            </SaveButton>
          </SaveForm>
        </ModalTrigger>
      </div>

      {activeCount === 1 && (
        <section className="card border-l-4 border-l-amber-500 p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-300">
              <ShieldAlert className="size-4" />
            </span>
            <div className="text-sm">
              <p className="font-semibold">You are the only active platform admin.</p>
              <p className="mt-1 text-muted-foreground">
                Nobody can disable or delete the last active admin, so the console cannot
                become unadministrable — but there is also nobody to reset your password if
                you lose it. Recovery would mean editing the database by hand. Consider
                adding a second admin.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Enrolment state read from the row rather than the session claim: the
          session is minted at login and would not reflect 2FA turned on since. */}
      <TwoFactorPanel enabled={Boolean(myTotp?.totpEnabledAt)} />

      <section className="card p-5">
        <h2 className="font-semibold">Your password</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Changing it signs out every session, including this one.
        </p>
        <ChangeOwnPasswordForm />
      </section>

      <section className="card divide-y divide-border/50 p-0">
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="font-semibold">All admins</h2>
          <span className="text-xs text-muted-foreground">
            {admins.length} total · {activeCount} active
          </span>
        </div>

        {admins.map((admin) => {
          const isMe = admin.id === me.id;
          const disabled = Boolean(admin.disabledAt);
          return (
            <div key={admin.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {admin.name}
                    {isMe && <span className="badge bg-primary/15 text-primary">You</span>}
                    {disabled && <span className="badge bg-red-500/15 text-red-300">Disabled</span>}
                    {!disabled && admin._count.sessions > 0 && (
                      <span className="badge bg-emerald-500/15 text-emerald-300">
                        {admin._count.sessions} active session{admin._count.sessions === 1 ? "" : "s"}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{admin.email}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {admin.lastLoginAt
                      ? <>Last signed in {formatDateTime(admin.lastLoginAt)}</>
                      : <>Never signed in</>}
                    {" · "}
                    added {formatDateTime(admin.createdAt)}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {admin._count.sessions > 0 && (
                    <SaveForm
                      action={revokePlatformAdminSessionsAction.bind(null, admin.id)}
                      success={`Signed ${admin.name} out everywhere`}
                    >
                      <SaveButton
                        pendingLabel="Revoking…"
                        className="btn-secondary btn-sm inline-flex items-center gap-1.5"
                        title="Sign this admin out of every device"
                      >
                        <LogOut className="size-3.5" />
                        Revoke sessions
                      </SaveButton>
                    </SaveForm>
                  )}

                  {!isMe && (
                    <ModalTrigger
                      label={<><KeyRound className="size-3.5" />Reset password</>}
                      title={`Reset password for ${admin.name}`}
                      buttonClass="btn-secondary btn-sm inline-flex items-center gap-1.5"
                    >
                      <SaveForm
                        action={resetPlatformAdminPasswordAction.bind(null, admin.id)}
                        success={`Password reset for ${admin.name}`}
                        className="space-y-4"
                      >
                        <div>
                          <label className="label">New password</label>
                          <input name="newPassword" type="password" className="input" required minLength={12} autoFocus />
                          <p className="mt-1 text-xs text-muted-foreground">
                            At least 12 characters, including letters and numbers. This signs
                            them out everywhere; tell them the new password yourself.
                          </p>
                        </div>
                        <SaveButton pendingLabel="Resetting…" className="btn-primary w-full">
                          Reset password
                        </SaveButton>
                      </SaveForm>
                    </ModalTrigger>
                  )}

                  {!isMe && (
                    <SaveForm
                      action={setPlatformAdminDisabledAction.bind(null, admin.id, !disabled)}
                      success={disabled ? `${admin.name} re-enabled` : `${admin.name} disabled`}
                    >
                      <SaveButton
                        pendingLabel={disabled ? "Re-enabling…" : "Disabling…"}
                        className="btn-secondary btn-sm"
                      >
                        {disabled ? "Re-enable" : "Disable"}
                      </SaveButton>
                    </SaveForm>
                  )}

                  {!isMe && (
                    <ModalTrigger
                      label={<Trash2 className="size-3.5" />}
                      title={`Delete ${admin.name}?`}
                      buttonClass="btn-secondary btn-sm text-red-300"
                    >
                      <SaveForm
                        action={deletePlatformAdminAction.bind(null, admin.id)}
                        success={`${admin.name} deleted`}
                        className="space-y-4"
                      >
                        <p className="text-sm text-muted-foreground">
                          This is permanent and takes their sessions with it. Disabling is
                          reversible and usually the better choice.
                        </p>
                        <SaveButton
                          pendingLabel="Deleting…"
                          className="btn-primary w-full bg-red-600 hover:bg-red-500"
                        >
                          Delete permanently
                        </SaveButton>
                      </SaveForm>
                    </ModalTrigger>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
