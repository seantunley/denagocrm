"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange, X } from "lucide-react";
import { cn } from "@/lib/utils";

const PRESETS = [
  { id: "mtd", label: "This month" },
  { id: "30d", label: "30 days" },
  { id: "qtr", label: "Quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "12m", label: "12 months" },
  { id: "custom", label: "Custom" },
];

export type FilterOptions = {
  users: { id: string; name: string }[];
  products: { id: string; name: string }[];
  sources: string[];
};

/**
 * Global report filters. State lives in the URL (?range=&user=&product=&source=)
 * so views are shareable/bookmarkable and the server re-queries on change.
 */
export default function ReportFilters({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const range = params.get("range") ?? "mtd";
  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [params, pathname, router]
  );

  const hasFilters = !!(params.get("user") || params.get("product") || params.get("source"));

  const select =
    "h-8 rounded-md border border-input bg-card px-2.5 text-[13px] text-foreground outline-none transition-colors hover:border-ring/60 focus:border-ring focus:ring-2 focus:ring-ring/20";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 p-2 backdrop-blur transition-opacity",
        pending && "opacity-60"
      )}
    >
      <span className="hidden items-center gap-1.5 pl-1.5 pr-0.5 text-xs font-medium text-muted-foreground sm:flex">
        <CalendarRange className="size-3.5" />
      </span>

      {/* Date presets — segmented control */}
      <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => set({ range: p.id })}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              range === p.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {range === "custom" && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            className={select}
            value={params.get("from") ?? ""}
            onChange={(e) => set({ from: e.target.value })}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            className={select}
            value={params.get("to") ?? ""}
            onChange={(e) => set({ to: e.target.value })}
          />
        </div>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <select
          className={select}
          value={params.get("user") ?? ""}
          onChange={(e) => set({ user: e.target.value || null })}
        >
          <option value="">All team</option>
          {options.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>

        <select
          className={select}
          value={params.get("product") ?? ""}
          onChange={(e) => set({ product: e.target.value || null })}
        >
          <option value="">All products</option>
          {options.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <select
          className={select}
          value={params.get("source") ?? ""}
          onChange={(e) => set({ source: e.target.value || null })}
        >
          <option value="">All sources</option>
          {options.sources.map((s) => (
            <option key={s} value={s} className="capitalize">
              {s}
            </option>
          ))}
        </select>

        {hasFilters && (
          <button
            onClick={() => set({ user: null, product: null, source: null })}
            className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Clear filters"
          >
            <X className="size-3.5" />
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
