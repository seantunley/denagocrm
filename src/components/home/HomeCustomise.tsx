"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Palette,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

type Density = "comfortable" | "compact";
type Surface = "quiet" | "rich";
type TopRegion = "metrics" | "workspace" | "lower";
type LowerRegion = "attention" | "movement";

type HomePrefs = {
  hidden: string[];
  density: Density;
  surface: Surface;
  order: TopRegion[];
  lowerOrder: LowerRegion[];
};

const STORAGE_KEY = "denago-home-v3";
const LEGACY_STORAGE_KEY = "denago-home-v2";

const sections = [
  { id: "metrics", title: "Key numbers", description: "Leads, pipeline, won value and deliveries" },
  { id: "workspace", title: "Daily workspace", description: "Today, pipeline and monthly pace" },
  { id: "attention", title: "Needs attention", description: "Leads without a planned next step" },
  { id: "movement", title: "Recent movement", description: "New leads, quotes and signing activity" },
] as const;

const topRegions: Array<{ id: TopRegion; title: string }> = [
  { id: "metrics", title: "Key numbers" },
  { id: "workspace", title: "Daily workspace" },
  { id: "lower", title: "Attention & movement" },
];

const DEFAULT_PREFS: HomePrefs = {
  hidden: [],
  density: "comfortable",
  surface: "rich",
  order: ["metrics", "workspace", "lower"],
  lowerOrder: ["attention", "movement"],
};

function validOrder<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return fallback;
  const allowedSet = new Set<string>(allowed);
  const picked = value.filter((item): item is T => typeof item === "string" && allowedSet.has(item));
  if (picked.length !== allowed.length || new Set(picked).size !== allowed.length) return fallback;
  return picked;
}

function readPrefs(): HomePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    const parsed = JSON.parse(raw ?? "null") as Partial<HomePrefs> | null;
    if (!parsed) return DEFAULT_PREFS;
    const validIds = new Set(sections.map((section) => section.id));
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((id) => validIds.has(id as never)) : [],
      density: parsed.density === "compact" ? "compact" : "comfortable",
      surface: parsed.surface === "quiet" ? "quiet" : "rich",
      order: validOrder(parsed.order, ["metrics", "workspace", "lower"] as const, DEFAULT_PREFS.order),
      lowerOrder: validOrder(parsed.lowerOrder, ["attention", "movement"] as const, DEFAULT_PREFS.lowerOrder),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * CRMHome stays a server component so its permission-scoped data never moves to
 * the browser. This client helper only personalises presentation. The markers are
 * attached after hydration to stable, top-level home regions; no CRM data or
 * permissions are changed when a region is hidden or moved.
 */
function markHomeRegions(root: HTMLElement) {
  const home = root.querySelector<HTMLElement>("main");
  if (!home) return;

  const children = Array.from(home.children) as HTMLElement[];
  const header = children.find((child) => child.tagName === "HEADER");
  const metrics = children.find((child) => child.tagName === "SECTION");
  const grids = children.filter((child) => child.tagName === "DIV" && child.classList.contains("grid"));
  const workspace = grids[0];
  const lower = grids[1];

  if (header) header.dataset.homeFixed = "true";
  if (metrics) {
    metrics.dataset.homeSection = "metrics";
    metrics.dataset.homeTopRegion = "metrics";
  }
  if (workspace) {
    workspace.dataset.homeSection = "workspace";
    workspace.dataset.homeTopRegion = "workspace";
  }
  if (lower) {
    lower.dataset.homeLower = "true";
    lower.dataset.homeTopRegion = "lower";
    const lowerSections = Array.from(lower.children) as HTMLElement[];
    if (lowerSections[0]) lowerSections[0].dataset.homeSection = "attention";
    if (lowerSections[1]) lowerSections[1].dataset.homeSection = "movement";
  }

  home.querySelectorAll<HTMLElement>("section").forEach((element) => {
    element.dataset.homeCard = "true";
  });
  home.querySelectorAll<HTMLElement>("li").forEach((element) => {
    element.dataset.homeRow = "true";
  });
}

function applyPrefs(root: HTMLElement, prefs: HomePrefs) {
  root.dataset.homeDensity = prefs.density;
  root.dataset.homeSurface = prefs.surface;

  root.querySelectorAll<HTMLElement>("[data-home-section]").forEach((element) => {
    element.hidden = prefs.hidden.includes(element.dataset.homeSection ?? "");
  });

  const order = new Map(prefs.order.map((id, index) => [id, (index + 1) * 10]));
  root.querySelectorAll<HTMLElement>("[data-home-top-region]").forEach((element) => {
    const id = element.dataset.homeTopRegion as TopRegion | undefined;
    element.style.order = String(id ? order.get(id) ?? 100 : 100);
  });

  const lowerOrder = new Map(prefs.lowerOrder.map((id, index) => [id, index + 1]));
  root.querySelectorAll<HTMLElement>("[data-home-lower] > [data-home-section]").forEach((element) => {
    const id = element.dataset.homeSection as LowerRegion | undefined;
    element.style.order = String(id ? lowerOrder.get(id) ?? 10 : 10);
  });

  const lower = root.querySelector<HTMLElement>("[data-home-lower]");
  if (lower) {
    lower.hidden = prefs.hidden.includes("attention") && prefs.hidden.includes("movement");
  }
}

export default function HomeCustomise() {
  const [prefs, setPrefs] = useState<HomePrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-home-root]");
    if (root) markHomeRegions(root);
    setPrefs(readPrefs());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    /*
     * THE WRITE IS GUARDED, LIKE THE READ.
     *
     * `readPrefs` already try/catches, and the write needs it for the same
     * reasons and one more. `setItem` throws — not returns — when storage is
     * unavailable or full: Safari private browsing, a browser set to block site
     * data, and QuotaExceededError all raise here. Unhandled inside an effect,
     * that propagates to the nearest error boundary and takes the whole home
     * screen down. Failing to remember a layout preference must not cost the
     * user the page it decorates.
     *
     * `applyPrefs` runs REGARDLESS, outside the try: the preference is still
     * valid for this session even when it cannot be persisted for the next, so
     * the customiser keeps working and simply forgets on reload.
     */
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Not remembering is acceptable; crashing the home screen is not.
    }
    const root = document.querySelector<HTMLElement>("[data-home-root]");
    if (root) applyPrefs(root, prefs);
  }, [prefs, ready]);

  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden]);

  function toggle(id: string) {
    setPrefs((current) => ({
      ...current,
      hidden: current.hidden.includes(id)
        ? current.hidden.filter((item) => item !== id)
        : [...current.hidden, id],
    }));
  }

  function moveTop(id: TopRegion, direction: -1 | 1) {
    setPrefs((current) => {
      const order = [...current.order];
      const index = order.indexOf(id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= order.length) return current;
      [order[index], order[next]] = [order[next], order[index]];
      return { ...current, order };
    });
  }

  function moveLower(id: LowerRegion, direction: -1 | 1) {
    setPrefs((current) => {
      const order = [...current.lowerOrder];
      const index = order.indexOf(id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= order.length) return current;
      [order[index], order[next]] = [order[next], order[index]];
      return { ...current, lowerOrder: order };
    });
  }

  function reset() {
    setPrefs(DEFAULT_PREFS);
  }

  return (
    <>
      <style>{`
        [data-home-root] main { display: flex; flex-direction: column; }
        [data-home-root] main > [data-home-fixed] { order: -1000; }
        [data-home-root][data-home-density="compact"] [data-home-card] { padding-top: 1rem !important; padding-bottom: 1rem !important; }
        [data-home-root][data-home-density="compact"] [data-home-row] { padding-top: .7rem !important; padding-bottom: .7rem !important; }
        [data-home-root][data-home-density="compact"] main { row-gap: 1rem !important; }
        [data-home-lower]:has(> [data-home-section="attention"][hidden]) > [data-home-section="movement"],
        [data-home-lower]:has(> [data-home-section="movement"][hidden]) > [data-home-section="attention"] { grid-column: 1 / -1; }

        [data-home-root][data-home-surface="rich"] [data-home-section="metrics"] {
          position: relative;
          isolation: isolate;
          background:
            radial-gradient(circle at 8% 10%, color-mix(in srgb, var(--primary) 17%, transparent), transparent 28%),
            linear-gradient(135deg, var(--card), color-mix(in srgb, var(--card) 88%, var(--primary) 12%));
        }
        [data-home-root][data-home-surface="rich"] [data-home-section="metrics"]::after {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--primary) 7%, transparent), transparent);
          opacity: .8;
        }
        [data-home-root][data-home-surface="rich"] [data-home-card] {
          box-shadow: 0 14px 38px rgba(0,0,0,.14);
        }
        [data-home-root][data-home-surface="quiet"] [data-home-card] {
          box-shadow: none !important;
          background-image: none !important;
        }
      `}</style>

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border/70 bg-card px-3.5 py-2 text-sm font-medium text-foreground transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            Customise home
          </button>
        </SheetTrigger>
        <SheetContent className="sm:max-w-md">
          <SheetHeader className="border-b border-border/60 px-5 py-5">
            <SheetTitle className="text-lg">Customise home</SheetTitle>
            <SheetDescription>
              Change the look, density and order of your Home without changing what CRM data you are allowed to see.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-5 py-2">
            <div className="border-b border-border/50 py-5">
              <p className="text-sm font-semibold text-foreground">Appearance</p>
              <p className="mt-1 text-xs text-muted-foreground">Choose how much visual emphasis the dashboard carries.</p>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-muted/35 p-1">
                {(["rich", "quiet"] as Surface[]).map((surface) => (
                  <button
                    key={surface}
                    type="button"
                    onClick={() => setPrefs((current) => ({ ...current, surface }))}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium capitalize transition",
                      prefs.surface === surface
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Palette className="size-3.5" />
                    {surface}
                  </button>
                ))}
              </div>

              <p className="mt-5 text-sm font-semibold text-foreground">Density</p>
              <p className="mt-1 text-xs text-muted-foreground">Choose how much information fits on screen.</p>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-muted/35 p-1">
                {(["comfortable", "compact"] as Density[]).map((density) => (
                  <button
                    key={density}
                    type="button"
                    onClick={() => setPrefs((current) => ({ ...current, density }))}
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm font-medium capitalize transition",
                      prefs.density === density
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {density}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-b border-border/50 py-5">
              <p className="text-sm font-semibold text-foreground">Page order</p>
              <p className="mt-1 text-xs text-muted-foreground">Move the major dashboard regions up or down.</p>
              <div className="mt-3 space-y-2">
                {prefs.order.map((id, index) => {
                  const region = topRegions.find((item) => item.id === id)!;
                  return (
                    <div key={id} className="flex items-center gap-3 rounded-xl border border-border/55 bg-card/60 px-3.5 py-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/50 text-xs font-semibold text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{region.title}</span>
                      <button
                        type="button"
                        aria-label={`Move ${region.title} up`}
                        disabled={index === 0}
                        onClick={() => moveTop(id, -1)}
                        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-25"
                      >
                        <ArrowUp className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${region.title} down`}
                        disabled={index === prefs.order.length - 1}
                        onClick={() => moveTop(id, 1)}
                        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-25"
                      >
                        <ArrowDown className="size-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="py-5">
              <p className="text-sm font-semibold text-foreground">Sections</p>
              <p className="mt-1 text-xs text-muted-foreground">Hide sections you do not use and reorder the lower pair.</p>
              <div className="mt-3 space-y-2">
                {sections.map((section) => {
                  const isHidden = hidden.has(section.id);
                  const isLower = section.id === "attention" || section.id === "movement";
                  const lowerIndex = isLower ? prefs.lowerOrder.indexOf(section.id as LowerRegion) : -1;
                  return (
                    <div key={section.id} className="flex items-center gap-2 rounded-xl border border-border/55 bg-card/60 px-3.5 py-3">
                      <button
                        type="button"
                        onClick={() => toggle(section.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", isHidden ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
                          {isHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">{section.title}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{section.description}</span>
                        </span>
                      </button>
                      {isLower && (
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            aria-label={`Move ${section.title} left`}
                            disabled={lowerIndex === 0}
                            onClick={() => moveLower(section.id as LowerRegion, -1)}
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-25"
                          >
                            <ArrowUp className="size-4 -rotate-90" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${section.title} right`}
                            disabled={lowerIndex === prefs.lowerOrder.length - 1}
                            onClick={() => moveLower(section.id as LowerRegion, 1)}
                            className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-25"
                          >
                            <ArrowDown className="size-4 -rotate-90" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="border-t border-border/60 p-5">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              <RotateCcw className="size-4" />
              Reset home
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
