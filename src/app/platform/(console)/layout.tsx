import Link from "next/link";
import { Building2, LogOut } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/platformAuth";
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
  // NOTE: this deliberately does NOT refresh the session cookie. Next.js only
  // permits cookie mutation in Server Functions and Route Handlers; writing one
  // during Server Component rendering throws. The idle window is instead slid by
  // `requirePlatformAdminAction`, which every console server action calls — so an
  // admin who is actually working stays signed in, while one who merely leaves the
  // page open expires on schedule (which is the intent for a cross-tenant session).
  const admin = await requirePlatformAdmin();

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
          <nav className="ml-auto flex shrink-0 items-center gap-1 text-xs">
            <Link
              href="/platform/tenants"
              className="rounded-full px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Tenants
            </Link>
            <Link
              href="/platform/admins"
              className="rounded-full px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              Admins
            </Link>
          </nav>

          <form action={platformLogout} className="shrink-0">
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
