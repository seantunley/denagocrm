import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldAlert, Building2 } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { isPlatformAdmin } from "@/lib/tenantAdmin";

export const metadata: Metadata = {
  title: "Platform Console — Denago",
};

/**
 * Standalone platform-admin console, deliberately OUTSIDE the CRM `(app)` route
 * group: no AppShell, no settings nav, no module route-guards — a distinct surface
 * for cross-tenant super-admin work. It reuses the CRM's session mechanism
 * (`getCurrentUser`, the same cookie/session validation the `(app)` layout's
 * `requireUser` runs) but gates on the GLOBAL `owner` role. Anonymous callers go to
 * login; authenticated non-owners get a not-authorized state instead of the console.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Building2 className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">Platform Console</p>
            <p className="text-xs text-muted-foreground">Cross-tenant administration · Denago</p>
          </div>
          <span className="ml-auto rounded-full border border-border bg-muted/40 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Super admin
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {isPlatformAdmin(user.role) ? (
          children
        ) : (
          <div className="card mx-auto max-w-lg p-8 text-center">
            <span className="mx-auto mb-4 grid size-12 place-items-center rounded-full border border-red-500/20 bg-red-500/10 text-red-400">
              <ShieldAlert className="size-6" />
            </span>
            <h1 className="text-lg font-semibold">Not authorized</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The platform console is restricted to platform owners. Your account does not have access.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
