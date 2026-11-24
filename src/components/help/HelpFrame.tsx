"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/**
 * The help centre's frame. A GUIDE is read beside the side menu of every other
 * guide; the HOME is a front door and has the page to itself — a menu of two
 * hundred titles beside it buried the search, the paths and the areas it exists
 * to show (2026-11-24). The layout is a server component and cannot know the
 * path, so this asks.
 */
export default function HelpFrame({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/help") return <div className="mx-auto w-full max-w-6xl">{children}</div>;
  return (
    <div className="grid gap-8 lg:grid-cols-[288px_minmax(0,1fr)]">
      <aside className="hidden lg:sticky lg:top-6 lg:block lg:max-h-[calc(100dvh-3rem)] lg:self-start lg:overflow-y-auto lg:pr-1">{nav}</aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
