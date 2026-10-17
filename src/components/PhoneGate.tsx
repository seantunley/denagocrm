"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Monitor } from "lucide-react";
import { onPhone } from "@/lib/phoneScope";

/**
 * A page outside the phone app (lib/phoneScope.ts), opened on a phone: a short
 * notice that it is built for a computer — and "Open anyway", so nobody is ever
 * stuck. CSS decides what a phone is (below 768px), so the server renders one
 * page for every screen and a tablet or a computer never sees the notice.
 */
export default function PhoneGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const here = `${pathname}?${tab ?? ""}`;
  const [openedAnyway, setOpenedAnyway] = useState<string | null>(null);
  if (onPhone(pathname, tab) || openedAnyway === here) return <>{children}</>;
  return (
    <>
      <div className="md:hidden" data-testid="phone-notice">
        <div className="mx-auto mt-6 max-w-sm rounded-xl border border-border bg-card p-6 text-center">
          <Monitor className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
          <h1 className="mt-3 text-lg font-semibold">Open this on a computer</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This part of the CRM is built for a bigger screen. On your phone you have sales, the workshop, the help desk and deliveries.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <Link href="/" className="btn-primary justify-center">Go to Home</Link>
            <button type="button" className="btn-secondary justify-center" onClick={() => setOpenedAnyway(here)}>
              Open anyway
            </button>
          </div>
        </div>
      </div>
      <div className="max-md:hidden">{children}</div>
    </>
  );
}
