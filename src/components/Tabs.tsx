"use client";

import { useState, type ReactNode } from "react";

export type TabDef = {
  key: string;
  label: string;
  count?: number;
  content: ReactNode;
};

export default function Tabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(tabs[0]?.key);

  return (
    <div>
      <div className="flex gap-1 border-b border-slate-800 mb-5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px cursor-pointer select-none transition-colors ${
              active === t.key
                ? "border-orange-500 text-orange-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span
                className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                  active === t.key
                    ? "bg-orange-500/15 text-orange-300"
                    : "bg-slate-800 text-slate-300"
                }`}
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
