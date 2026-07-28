import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Platform Console — Denago",
};

/**
 * Outer shell for the platform surface, deliberately OUTSIDE the CRM `(app)` route
 * group: no AppShell, no settings nav, no module route-guards.
 *
 * This layout does NOT authenticate. `/platform/login` lives under it and must
 * stay reachable while signed out, so the gate sits one level down in the
 * `(console)` route group — every real console page is protected, the login page
 * is not. Gating here would have redirected the login page to itself.
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-background text-foreground">{children}</div>;
}
