"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TabDef = {
  key: string;
  label: string;
  count?: number;
  content: ReactNode;
};

export default function Tabs({ tabs, initialKey }: { tabs: TabDef[]; initialKey?: string }) {
  const [active, setActive] = useState(
    initialKey && tabs.some((t) => t.key === initialKey) ? initialKey : tabs[0]?.key
  );

  return (
    <div>
      <div className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-border bg-card/70 p-1 shadow-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
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
          {t.content}
        </div>
      ))}
    </div>
  );
}
