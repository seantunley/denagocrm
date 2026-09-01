"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, RotateCcw, SlidersHorizontal } from "lucide-react";
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

type HomePrefs = {
  hidden: string[];
  density: Density;
};

const STORAGE_KEY = "denago-home-v2";

const sections = [
  { id: "metrics", title: "Key numbers", description: "Leads, pipeline, won value and deliveries" },
  { id: "workspace", title: "Daily workspace", description: "Today, pipeline and monthly pace" },
  { id: "attention", title: "Needs attention", description: "Leads without a planned next step" },
  { id: "movement", title: "Recent movement", description: "New leads, quotes and signing activity" },
] as const;

const DEFAULT_PREFS: HomePrefs = { hidden: [], density: "comfortable" };

function readPrefs(): HomePrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<HomePrefs> | null;
    if (!parsed) return DEFAULT_PREFS;
    const validIds = new Set(sections.map((section) => section.id));
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((id) => validIds.has(id as never)) : [],
      density: parsed.density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export default function HomeCustomise() {
  const [prefs, setPrefs] = useState<HomePrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(readPrefs());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));

    const root = document.querySelector<HTMLElement>("[data-home-root]");
    if (root) root.dataset.homeDensity = prefs.density;

    document.querySelectorAll<HTMLElement>("[data-home-section]").forEach((element) => {
      element.hidden = prefs.hidden.includes(element.dataset.homeSection ?? "");
    });
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

  function reset() {
    setPrefs(DEFAULT_PREFS);
  }

  return (
    <>
      <style>{`
        [data-home-root][data-home-density="compact"] [data-home-card] { padding-top: 1rem !important; padding-bottom: 1rem !important; }
        [data-home-root][data-home-density="compact"] [data-home-row] { padding-top: .7rem !important; padding-bottom: .7rem !important; }
        [data-home-root][data-home-density="compact"] { row-gap: 1rem !important; }
        [data-home-lower]:has(> [data-home-section="attention"][hidden]) > [data-home-section="movement"],
        [data-home-lower]:has(> [data-home-section="movement"][hidden]) > [data-home-section="attention"] { grid-column: 1 / -1; }
      `}</style>

      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border/70 bg-card px-3.5 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            Customise home
          </button>
        </SheetTrigger>
        <SheetContent className="sm:max-w-md">
          <SheetHeader className="border-b border-border/60 px-5 py-5">
            <SheetTitle className="text-lg">Customise home</SheetTitle>
            <SheetDescription>
              Keep the home screen focused on the information you actually use. These preferences are saved in this browser.
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-5 py-2">
            <div className="border-b border-border/50 py-5">
              <p className="text-sm font-semibold text-foreground">Density</p>
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

            <div className="py-5">
              <p className="text-sm font-semibold text-foreground">Sections</p>
              <p className="mt-1 text-xs text-muted-foreground">Hide anything that is not useful to your role.</p>
              <div className="mt-3 space-y-2">
                {sections.map((section) => {
                  const isHidden = hidden.has(section.id);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      onClick={() => toggle(section.id)}
                      className="flex w-full items-center gap-3 rounded-xl border border-border/55 bg-card/60 px-3.5 py-3 text-left transition hover:bg-muted/40"
                    >
                      <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", isHidden ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
                        {isHidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">{section.title}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{section.description}</span>
                      </span>
                      <span className="text-xs font-medium text-muted-foreground">{isHidden ? "Hidden" : "Shown"}</span>
                    </button>
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
