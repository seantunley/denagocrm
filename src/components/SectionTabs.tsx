"use client";

import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { tabAfterKey, tabFromHash } from "@/lib/sectionTabs";

export type SectionTab = { id: string; label: string; /** A number worth acting on, shown as a pill (hidden at 0). */ count?: number };

const CHANGED = "section-tab-changed";
function subscribe(onChange: () => void) {
  // popstate: Back and Forward between tabs (pushState below adds no hashchange of its own).
  window.addEventListener("popstate", onChange);
  window.addEventListener("hashchange", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

/**
 * A long settings page as tabs: one section on screen at a time instead of
 * seven stacked down the page (lib/sectionTabs.ts).
 *
 * EVERY PANEL STAYS IN THE PAGE, hidden — so a half-typed form in one tab is
 * still there after a look at another, and each section's own Save still posts.
 * The open tab lives in the address (`#learned`), not in React state, so links
 * to a section, Back and Forward all work. The first tab shows until the page
 * is live.
 */
export default function SectionTabs({ label, tabs, panels }: { label: string; tabs: SectionTab[]; panels: Record<string, ReactNode> }) {
  const ids = tabs.map((tab) => tab.id);
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  const active = tabFromHash(hash, ids, ids[0]);
  const list = useRef<HTMLDivElement>(null);

  function open(id: string, focus = false) {
    // A NEW history entry per tab, so Back and Forward step through the tabs visited (review of #1223 — replaceState
    // left Back jumping straight off the page). pushState, not `location.hash =`, which would also scroll to the
    // element with this id. Choosing the tab already open adds nothing.
    if (id !== active) window.history.pushState(null, "", `#${id}`);
    window.dispatchEvent(new Event(CHANGED));
    if (focus) list.current?.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)?.focus();
  }

  return (
    <div>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        className="mb-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 depth-card [scrollbar-width:none]"
        onKeyDown={(event) => {
          const next = tabAfterKey(event.key, ids, active);
          if (!next) return;
          event.preventDefault();
          open(next, true);
        }}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              data-tab={tab.id}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => open(tab.id)}
              className={cn(
                "inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition-colors",
                selected ? "bg-white/[0.08] text-foreground depth-secondary" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.count ? (
                <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} role="tabpanel" id={`panel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={tab.id !== active} className="max-w-3xl space-y-6">
          {panels[tab.id]}
        </div>
      ))}
    </div>
  );
}
