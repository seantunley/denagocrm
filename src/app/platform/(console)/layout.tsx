import { Building2, LogOut } from "lucide-react";
import { requirePlatformAdmin, touchPlatformSession } from "@/lib/platformAuth";
import { platformLogout } from "@/app/platform/login/actions";

/**
 * Authenticated console shell. Every page in this route group requires a
 * PlatformAdmin session — NOT a CRM user, and NOT a tenant membership.
 *
 * `requirePlatformAdmin` redirects to `/platform/login` (the console's own login,
 * never the CRM's), so an unauthenticated visitor is not bounced into a tenant
 * surface. There is no "authenticated but not authorized" state any more: holding
 * a valid platform session IS the authorization, because the identity exists only
 * for this console.
 */
export default async function PlatformConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requirePlatformAdmin();
  // Slide the idle window so a working session isn't cut off mid-task.
  await touchPlatformSession();

  return (
    <>
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Building2 className="size-[18px]" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">Platform Console</p>
            <p className="truncate text-xs text-muted-foreground">
              Cross-tenant administration · {admin.email}
            </p>
          </div>
          <form action={platformLogout} className="ml-auto shrink-0">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-primary/35 hover:text-foreground"
            >
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </>
  );
}
