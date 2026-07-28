"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TabDef = {
  key: string;
  label: string;
  count?: number;
  content: ReactNode;
  /**
   * Hold this panel back until its tab is first opened.
   *
   * Every other panel is mounted up front so in-progress form input survives a
   * tab switch (see below). That is the wrong trade for a panel whose work is
   * expensive, because it pays the cost for everyone who never opens it. Once
   * opened the panel STAYS mounted, so switching away and back is free and the
   * typing guarantee still holds from that point on.
   *
   * Only meaningful for content that does its own client-side loading: a server
   * component passed in as `content` is already rendered by the time this
   * component sees it, so withholding it here would save nothing.
   */
  lazy?: boolean;
};

export default function Tabs({ tabs, initialKey }: { tabs: TabDef[]; initialKey?: string }) {
  const first =
    initialKey && tabs.some((t) => t.key === initialKey) ? initialKey : tabs[0]?.key;
  const [active, setActive] = useState(first);
  const [opened, setOpened] = useState<string[]>(first ? [first] : []);

  const select = (key: string) => {
    setActive(key);
    setOpened((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  return (
    <div>
      <div className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-border bg-card/70 p-1 shadow-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => select(t.key)}
            className={cn(
              "select-none whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-medium transition-all",
              active === t.key
                ? "bg-white/[0.07] text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-white/[0.035] hover:text-foreground"
            )}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span
                className={cn(
                  "ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                  active === t.key
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* Panels stay mounted so in-progress form input survives tab switches */}
      {tabs.map((t) => (
        <div key={t.key} hidden={active !== t.key} className="space-y-6">
          {!t.lazy || opened.includes(t.key) ? t.content : null}
        </div>
      ))}
    </div>
  );
}
