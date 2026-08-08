"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CalendarPlus,
  Camera,
  CirclePlus,
  FileText,
  FileUp,
  LayoutDashboard,
  ListChecks,
  Menu,
  Route,
  Search,
  UserPlus,
  Wrench,
} from "lucide-react";
import { openCommandMenu } from "@/components/CommandMenu";
import { openQuickCreate, type QuickCreateKind } from "@/components/QuickCreateDialog";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { isPathEnabled } from "@/lib/modules/registry";
import { cn } from "@/lib/utils";

type MobileUser = { role: string; permissions: string[] };

export default function MobileCompanionNav({
  user,
  pathname,
  inboxWaiting,
  casesWaiting,
  enabledModules,
  onMore,
}: {
  user: MobileUser;
  pathname: string;
  inboxWaiting: number;
  casesWaiting: number;
  enabledModules?: string[];
  onMore: () => void;
}) {
  const [captureOpen, setCaptureOpen] = useState(false);
  const granted = new Set(user.permissions);
  const can = (...keys: string[]) => user.role === "owner" || keys.some((key) => granted.has(key));
  const enabledSet = enabledModules ? new Set(enabledModules) : undefined;
  const packOn = (href: string) => !enabledSet || isPathEnabled(href, enabledSet);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);
  const task = can("activities.view", "activities.manage") && packOn("/activities")
    ? { href: "/activities", badge: 0 }
    : can("cases.view_all", "cases.view_owned") && packOn("/cases")
      ? { href: "/cases", badge: casesWaiting }
      : can("inbox.view", "inbox.reply") && packOn("/inbox")
        ? { href: "/inbox", badge: inboxWaiting }
        : { href: "/", badge: 0 };

  const quickCapture = (kind: QuickCreateKind) => {
    setCaptureOpen(false);
    window.setTimeout(() => openQuickCreate(kind), 120);
  };
  // CAPTURE SHORTCUTS ADVERTISE A WRITE, so they ask for the write permission.
  // "Job card photos" and "Delivery photos" were gated on the VIEW keys while the
  // forms they lead to require manage — not an authorization bypass, since the
  // upload action checks for itself, but it offered a view-only technician a
  // camera button that could only end in a refusal.
  const captures = [
    { label: "New lead", detail: "Start a sales opportunity", icon: UserPlus, kind: "lead" as const, show: can("leads.create") },
    { label: "New contact", detail: "Capture a customer", icon: UserPlus, kind: "contact" as const, show: can("contacts.create") },
    { label: "New activity", detail: "Schedule the next step", icon: CalendarPlus, kind: "calendar" as const, show: can("activities.manage") },
    { label: "New quote", detail: "Start a customer proposal", icon: FileText, kind: "quote" as const, show: can("quotes.create") },
  ].filter((item) => item.show);

  const itemClass = (selected = false) => cn(
    "relative flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl text-[10px] font-medium",
    selected ? "bg-primary/10 text-primary" : "text-muted-foreground",
  );

  return (
    <>
      <nav data-mobile-navigation="true" className="fixed inset-x-3 bottom-[max(.75rem,env(safe-area-inset-bottom))] z-50 grid grid-cols-5 rounded-2xl border border-sidebar-border bg-sidebar/95 p-1.5 shadow-[0_22px_60px_rgba(0,0,0,.55)] backdrop-blur-xl lg:hidden" aria-label="Primary navigation">
        <Link href="/" aria-current={active("/") ? "page" : undefined} className={itemClass(active("/"))}><LayoutDashboard className="size-[18px]" />Home</Link>
        <Link href={task.href} aria-current={active(task.href) ? "page" : undefined} className={itemClass(active(task.href))}>
          <ListChecks className="size-[18px]" />Tasks
          {task.badge > 0 && <span className="absolute right-[22%] top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[8px] font-bold leading-4 text-primary-foreground">{task.badge > 99 ? "99+" : task.badge}</span>}
        </Link>
        <button type="button" onClick={() => setCaptureOpen(true)} className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl bg-primary text-[10px] font-semibold text-primary-foreground shadow-lg shadow-primary/20"><CirclePlus className="size-5" />Capture</button>
        <button type="button" onClick={openCommandMenu} className={itemClass()}><Search className="size-[18px]" />Search</button>
        <button type="button" onClick={onMore} className={itemClass()}><Menu className="size-[18px]" />More</button>
      </nav>

      <Sheet open={captureOpen} onOpenChange={setCaptureOpen}>
        <SheetContent side="bottom" className="max-h-[86dvh] overflow-y-auto rounded-t-3xl border-border bg-background p-0 lg:hidden">
          <SheetHeader className="border-b border-border px-5 pb-4 pt-6 text-left">
            <SheetTitle>Quick capture</SheetTitle>
            <SheetDescription>Start the record now. Complete the detail on desktop when needed.</SheetDescription>
          </SheetHeader>
          <div className="grid gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {captures.map(({ label, detail, icon: Icon, kind }) => (
              <button key={kind} type="button" onClick={() => quickCapture(kind)} className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Icon className="size-[18px]" /></span>
                <span><span className="block text-sm font-semibold">{label}</span><span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span></span>
              </button>
            ))}
            {can("activities.manage") && packOn("/test-drives") && <SheetClose asChild><Link href="/test-drives" className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4"><span className="grid size-10 place-items-center rounded-xl bg-amber-400/10 text-amber-300"><Route className="size-[18px]" /></span><span><span className="block text-sm font-semibold">Test drive</span><span className="mt-0.5 block text-xs text-muted-foreground">Start a booking or check current drives</span></span></Link></SheetClose>}
            {can("jobcards.manage") && packOn("/jobcards") && <SheetClose asChild><Link href="/jobcards" className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4"><span className="grid size-10 place-items-center rounded-xl bg-violet-400/10 text-violet-300"><Wrench className="size-[18px]" /></span><span><span className="block text-sm font-semibold">Job card photos</span><span className="mt-0.5 block text-xs text-muted-foreground">Photograph vehicle condition</span></span></Link></SheetClose>}
            {can("deliveries.manage") && packOn("/deliveries") && <SheetClose asChild><Link href="/deliveries" className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4"><span className="grid size-10 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><Camera className="size-[18px]" /></span><span><span className="block text-sm font-semibold">Delivery photos</span><span className="mt-0.5 block text-xs text-muted-foreground">Capture handover evidence</span></span></Link></SheetClose>}
            {can("documents.upload") && packOn("/documents") && <SheetClose asChild><Link href="/documents" className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4"><span className="grid size-10 place-items-center rounded-xl bg-sky-400/10 text-sky-300"><FileUp className="size-[18px]" /></span><span><span className="block text-sm font-semibold">Document</span><span className="mt-0.5 block text-xs text-muted-foreground">Upload and file a document</span></span></Link></SheetClose>}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
