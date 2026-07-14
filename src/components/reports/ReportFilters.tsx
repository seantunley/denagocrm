"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarRange, SlidersHorizontal, X } from "lucide-react";
import MobileFilterDrawer from "@/components/MobileFilterDrawer";
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

export default function ReportFilters({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const range = params.get("range") ?? "mtd";

  const set = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
    },
    [params, pathname, router],
  );

  const activeCount = ["user", "product", "source"].filter((key) => params.get(key)).length;
  const select = "h-9 rounded-lg border border-input bg-card px-2.5 text-[13px] text-foreground outline-none transition-colors hover:border-ring/60 focus:border-ring focus:ring-2 focus:ring-ring/20";

  function controls(mobile = false) {
    return (
      <>
        <div className={cn("flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5", mobile && "overflow-x-auto")}>
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => set({ range: preset.id })}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                range === preset.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {range === "custom" && (
          <div className={cn("flex items-center gap-1.5", mobile && "grid grid-cols-[1fr_auto_1fr]")}>
            <input type="date" className={cn(select, mobile && "min-w-0")} value={params.get("from") ?? ""} onChange={(event) => set({ from: event.target.value })} />
            <span className="text-xs text-muted-foreground">to</span>
            <input type="date" className={cn(select, mobile && "min-w-0")} value={params.get("to") ?? ""} onChange={(event) => set({ to: event.target.value })} />
          </div>
        )}

        <div className={cn("flex items-center gap-1.5", mobile ? "grid gap-3" : "ml-auto flex-wrap")}>
          <label><span className={mobile ? "label" : "sr-only"}>Team member</span><select className={cn(select, mobile && "w-full")} value={params.get("user") ?? ""} onChange={(event) => set({ user: event.target.value || null })}><option value="">All team</option>{options.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
          <label><span className={mobile ? "label" : "sr-only"}>Product</span><select className={cn(select, mobile && "w-full")} value={params.get("product") ?? ""} onChange={(event) => set({ product: event.target.value || null })}><option value="">All products</option>{options.products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
          <label><span className={mobile ? "label" : "sr-only"}>Source</span><select className={cn(select, mobile && "w-full")} value={params.get("source") ?? ""} onChange={(event) => set({ source: event.target.value || null })}><option value="">All sources</option>{options.sources.map((source) => <option key={source} value={source} className="capitalize">{source}</option>)}</select></label>
          {activeCount > 0 && (
            <button type="button" onClick={() => set({ user: null, product: null, source: null })} className={cn("flex h-9 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", mobile && "border border-border")}>
              <X className="size-3.5" /> Clear filters
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <MobileFilterDrawer activeCount={activeCount} title="Report filters" description="Choose a period and narrow the report by team member, product or source.">
        <div className={cn("space-y-5 transition-opacity", pending && "opacity-60")}>
          <div className="flex items-center gap-2 text-sm font-medium"><SlidersHorizontal className="size-4 text-primary" />Reporting period</div>
          {controls(true)}
        </div>
      </MobileFilterDrawer>

      <div className={cn("hidden flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 p-2 backdrop-blur transition-opacity sm:flex", pending && "opacity-60")}>
        <CalendarRange className="ml-1 size-3.5 text-muted-foreground" />
        {controls()}
      </div>
    </>
  );
}
