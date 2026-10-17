"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Monitor } from "lucide-react";
import { onPhone } from "@/lib/phoneScope";

/**
 * A page outside the phone app (lib/phoneScope.ts), opened on a phone: it says
 * it is built for a computer, and the page itself is not there. The desktop
 * features are not available on a phone (Sean, 2026-10-17 — no "Open anyway").
 * CSS decides what a phone is (below 768px), so the server renders one page for
 * every screen and a tablet or a computer never sees the notice.
 */
export default function PhoneGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  if (onPhone(pathname, tab)) return <>{children}</>;
  return (
    <>
      <div className="md:hidden" data-testid="phone-notice">
        <div className="mx-auto mt-6 max-w-sm rounded-xl border border-border bg-card p-6 text-center">
          <Monitor className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold">Open this on a computer</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This part of the CRM is built for a bigger screen. On your phone you have sales, the workshop, the help desk and deliveries.
          </p>
          <Link href="/" className="btn-primary mt-5 justify-center">Go to Home</Link>
        </div>
      </div>
      {/* Hidden on a phone, with nothing that shows it (the server renders one page for every screen). */}
      <div className="max-md:hidden">{children}</div>
    </>
  );
}
