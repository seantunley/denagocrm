import { Smartphone, Monitor, LogOut, ShieldOff } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { basePrisma, prisma } from "@/lib/db";
import { actingOwnerTenantId } from "@/lib/actingScope";
import { maskWaId } from "@/lib/assistantWhatsAppRules";
import { unlinkWhatsAppFor } from "@/app/actions/assistantWhatsApp";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { actingTenantMemberIds } from "@/lib/tenantActor";
import { formatDateTime } from "@/lib/format";
import { revokeSession, revokeAllForUser } from "@/app/actions/sessions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";

export const dynamic = "force-dynamic";

/** Tiny UA → human label (enough for an audit log, no library needed). */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone/iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua) && !/Chrome/.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  return `${browser} · ${os}`;
}

function ago(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default async function SessionsPage() {
  await requireTenantOwner();

  // Sessions & devices is a per-PERSON view, and `User` is a global model, so an
  // unfiltered `findMany` showed one workspace's owner every other workspace's
  // staff — with their live device list, IP addresses and sign-in times, and a
  // "Sign out all" button next to each. That is a denial-of-service control over
  // strangers, handed out by a page that reads as a local audit screen.
  //
  // Membership of the ACTING workspace, disabled members included: a disabled
  // account is exactly the one an owner comes here to confirm is signed out.
  const memberIds = await actingTenantMemberIds();
  const users = await prisma.user.findMany({
    where: memberIds === null ? {} : { id: { in: memberIds } },
    orderBy: { name: "asc" },
    include: {
      sessions: {
        where: { revokedAt: null },
        orderBy: { lastActiveAt: "desc" },
      },
    },
  });
  const totalActive = users.reduce((s, u) => s + u.sessions.length, 0);
  // A phone linked to the assistant is a sign-in too. "Sign out all" ends it;
  // revoking ONE device doesn't (the phone isn't that device), so it's shown
  // here, next to the devices, with its own Unlink.
  const tenantId = await actingOwnerTenantId().catch(() => null);
  const phones = tenantId
    ? await basePrisma.assistantPhoneLink.findMany({
        where: { tenantId, waId: { not: null }, verifiedAt: { not: null } },
        select: { userId: true, waId: true },
      })
    : [];
  const phoneOf = new Map(phones.map((p) => [p.userId, p.waId]));

  return (
    <SettingsWorkspace
      current="sessions"
      title="Sessions & devices"
      description={`${totalActive} active device session${totalActive === 1 ? "" : "s"} · Review activity and revoke access immediately.`}
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-4">
        {users.map((u) => (
          <div key={u.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                {u.name}
                <span className="ml-2 text-xs font-normal capitalize text-muted-foreground">
                  {u.role} · {u.sessions.length} device{u.sessions.length === 1 ? "" : "s"}
                </span>
              </p>
              {u.sessions.length > 0 && (
                <form action={revokeAllForUser.bind(null, u.id)}>
                  <Button variant="outline" size="sm" type="submit">
                    <ShieldOff className="size-3.5" />
                    Sign out all
                  </Button>
                </form>
              )}
            </div>

            {phoneOf.has(u.id) && (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-[12px]">
                <span>
                  WhatsApp linked to the assistant <span className="text-muted-foreground">({maskWaId(phoneOf.get(u.id))})</span>
                </span>
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Unlink</button>}
                  title="Unlink this phone?"
                  description="Messages from it will be treated like any other number's. They can link again from the Ask page."
                  confirmLabel="Unlink"
                  destructive
                  onConfirm={unlinkWhatsAppFor.bind(null, u.id)}
                />
              </div>
            )}
            {u.sessions.length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground/70">No active sessions.</p>
            ) : (
              <ul className="divide-y divide-border/50">
                {u.sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 py-2">
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg",
                        s.platform === "pwa"
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {s.platform === "pwa" ? (
                        <Smartphone className="size-4" />
                      ) : (
                        <Monitor className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                        {deviceLabel(s.userAgent)}
                        {s.platform === "pwa" && (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                            Mobile app · 7-day session
                          </span>
                        )}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {s.ip ?? "IP unknown"} · signed in {formatDateTime(s.createdAt)} · active{" "}
                        {ago(s.lastActiveAt)}
                      </p>
                    </div>
                    <form action={revokeSession.bind(null, s.id)}>
                      <Button variant="ghost" size="sm" type="submit" title="Sign this device out">
                        <LogOut className="size-3.5" />
                        Revoke
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </SettingsWorkspace>
  );
}
