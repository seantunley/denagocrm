"use client";

import { useMemo } from "react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  LIMITS,
  walkCards,
  type CardConfig,
  type CardQuery,
} from "@/lib/dashboard/config";
import { DASHBOARD_CARDS, canSeeCard, isConditional } from "@/lib/dashboard/registry";
import { usableFields, usableSources, type SourceDef } from "@/lib/dashboard/sources";
import { newId, useEditor } from "./EditorProvider";

/**
 * Everything that can go on a dashboard, in one dialog.
 *
 * ── THIS IS THE DISCOVERABILITY SURFACE ─────────────────────────────────────
 *
 * A card type that is not in this list does not exist as far as anyone using the
 * product is concerned. That is why every entry carries a SKETCH as well as a
 * name: "Gauge" means nothing to somebody who has never seen one, and a list of
 * nine nouns is a list nobody reads to the end. The sketches are static divs —
 * a preview that ran the card's own query would make opening the picker cost
 * nine database round trips, on a dialog most people close again.
 *
 * ── WHY THE BUILT-IN LIST IS FILTERED, NOT GREYED OUT ───────────────────────
 *
 * The twelve code-defined cards go through `canSeeCard`, the SAME function the
 * renderer and the old add-card strip use. A picker built from the raw catalogue
 * would tell a user without `signing.view` that an "Out for signature" card
 * exists and read them its description — the existence and wording of a card is
 * itself a disclosure, and a dashboard is exactly where that kind of small leak
 * happens. Greying the entry out instead of removing it would leak the same
 * thing more politely.
 *
 * The same rule is why the data cards disappear entirely when the viewer may not
 * query any source: an entry that produces a card the compiler would refuse is
 * an entry that teaches somebody the feature is broken.
 */

/**
 * Who is asking, as PLAIN ARRAYS.
 *
 * The editor is a client component and the permission catalogue is not reachable
 * from one — `lib/permissions` pulls in Prisma and `next/navigation`. So the
 * viewer's resolved permissions and the tenant's enabled modules are handed down
 * from the server component that already resolved them once (see
 * `dashboardViewer` in lib/dashboard/data.ts). Arrays rather than Sets because
 * a Set does not survive the server→client boundary.
 *
 * There is deliberately no default. An access object that defaulted to "empty"
 * would silently offer nothing and look broken; one that defaulted to "all"
 * would leak the catalogue to everybody. Neither failure is one a caller should
 * be able to reach by forgetting a prop.
 */
export type EditorAccess = {
  permissions: readonly string[];
  modules: readonly string[];
};

/** One thing a person can add, ready to draw. */
type PickerEntry = {
  key: string;
  name: string;
  description: string;
  preview: React.ReactNode;
  /** Shown when the card comes and goes on its own. */
  badge?: string;
  /** Quiet note — "you already have one of these". Never a reason to refuse. */
  note?: string;
  build: () => CardConfig;
};

export default function CardPicker({
  open,
  onOpenChange,
  onPick,
  access,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Hand the caller a finished card. It decides WHERE it goes — this dialog has
   * no idea which section was clicked and should not have to be told.
   */
  onPick: (card: CardConfig) => void;
  access: EditorAccess;
}) {
  const { config } = useEditor();

  /*
   * Rebuilt only when the access lists actually change CONTENT.
   *
   * `access` is almost always an object literal in the parent's render, so a
   * dependency on the object itself would rebuild the whole catalogue on every
   * keystroke elsewhere in the editor. Same value-keyed trick the provider uses
   * to decide whether the server sent a genuinely different config.
   */
  const accessKey = `${access.permissions.join(",")}|${access.modules.join(",")}`;
  const sets = useMemo(
    () => ({
      permissions: new Set(access.permissions),
      modules: new Set(access.modules),
    }),
    // access is folded into accessKey by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessKey],
  );

  // Which built-ins are already somewhere on this dashboard. Not a filter: the
  // same summary legitimately belongs on two tabs, and refusing the second one
  // would be the editor deciding it knows better.
  const placedBuiltins = useMemo(() => {
    const placed = new Set<string>();
    for (const view of config.views) {
      for (const section of view.sections) {
        for (const card of walkCards(section.cards)) {
          if (card.type === "builtin") placed.add(card.card);
        }
      }
    }
    return placed;
  }, [config]);

  const sources = useMemo(() => usableSources(sets), [sets]);

  const readyMade = useMemo<PickerEntry[]>(
    () =>
      DASHBOARD_CARDS.filter((meta) => canSeeCard(meta, sets)).map((meta) => ({
        key: `builtin:${meta.id}`,
        name: meta.title,
        description: meta.description,
        preview: <BuiltinSketch />,
        // A conditional card that is added and then does not appear reads as a
        // broken button, so the badge is not decoration — it is the difference
        // between "nothing to show" and "this feature does not work".
        badge: isConditional(meta) ? "when relevant" : undefined,
        note: placedBuiltins.has(meta.id) ? "Already on this dashboard" : undefined,
        build: () => ({
          id: newId("card"),
          type: "builtin",
          card: meta.id,
          span: meta.span,
        }),
      })),
    [sets, placedBuiltins],
  );

  const buildYourOwn = useMemo<PickerEntry[]>(() => {
    const entries: PickerEntry[] = [];
    const source = sources[0];

    if (source) {
      entries.push({
        key: "stat",
        name: "Number",
        description:
          "One number out of your own data — how many, how much, the average — with an optional comparison against the period before.",
        preview: <StatSketch />,
        build: () => ({
          id: newId("card"),
          type: "stat",
          span: 1,
          query: startingQuery(source),
          metric: { fn: "count" },
          compare: false,
        }),
      });
      entries.push({
        key: "list",
        name: "List",
        description:
          "Rows from one source, in the columns you choose. Every row links to the record it came from.",
        preview: <ListSketch />,
        build: () => ({
          id: newId("card"),
          type: "list",
          span: 2,
          query: startingQuery(source),
          columns: startingColumns(source, sets),
        }),
      });
      entries.push({
        key: "gauge",
        name: "Progress ring",
        description: "How far a number has come against a target you set.",
        preview: <GaugeSketch />,
        build: () => ({
          id: newId("card"),
          type: "gauge",
          span: 1,
          query: startingQuery(source),
          metric: { fn: "count" },
          // Ten of something, which is a target somebody will change rather than
          // one they might mistake for a considered default.
          target: 10,
        }),
      });
    }

    /*
     * A chart needs a field it may GROUP by, and not every source has one the
     * viewer is allowed to use. Offering "Chart" anyway would produce a card
     * that fails `cardProblems` the moment it is saved — the editor would refuse
     * the user's own first click.
     */
    const groupable = sources.find((candidate) => firstGroupableKey(candidate, sets) !== null);
    if (groupable) {
      const groupBy = firstGroupableKey(groupable, sets)!;
      entries.push({
        key: "chart",
        name: "Chart",
        description: "Counts or totals broken down by a field, as bars or a doughnut.",
        preview: <ChartSketch />,
        build: () => ({
          id: newId("card"),
          type: "chart",
          span: 2,
          query: startingQuery(groupable),
          groupBy,
          metric: { fn: "count" },
          style: "bar",
        }),
      });
    }

    entries.push({
      key: "markdown",
      name: "Note",
      description:
        "A block of your own words — a reminder, a phone number, what the numbers beside it mean.",
      preview: <NoteSketch />,
      build: () => ({
        id: newId("card"),
        type: "markdown",
        span: 2,
        // Not empty: a note with no content renders nothing at all, and a card
        // that vanishes the moment you add it looks like a failure rather than
        // like an empty box waiting for words.
        content: "Your note goes here.",
      }),
    });

    entries.push({
      key: "button",
      name: "Shortcut",
      description: "A tile that opens a page inside the app.",
      preview: <ButtonSketch />,
      build: () => ({
        id: newId("card"),
        type: "button",
        span: 1,
        title: "Home",
        href: "/",
      }),
    });

    return entries;
  }, [sources, sets]);

  const layout = useMemo<PickerEntry[]>(
    () => [
      {
        key: "heading",
        name: "Heading",
        description: "A title and a rule, to break a long screen into parts. No panel, no data.",
        preview: <HeadingSketch />,
        build: () => ({
          id: newId("card"),
          type: "heading",
          // Headings span the row by default — that is what makes them dividers
          // rather than another card in the queue.
          span: 4,
          title: "New heading",
        }),
      },
      {
        key: "grid",
        name: "Grid",
        description: "Holds other cards in columns of its own, inside one slot of the page.",
        preview: <GridSketch />,
        build: () => ({
          id: newId("card"),
          type: "grid",
          span: 4,
          columns: 2,
          cards: [],
        }),
      },
      {
        key: "stack",
        name: "Stack",
        description: "Holds other cards one after another, down the page or across it.",
        preview: <StackSketch />,
        build: () => ({
          id: newId("card"),
          type: "stack",
          span: 2,
          direction: "vertical",
          cards: [],
        }),
      },
    ],
    [],
  );

  function choose(entry: PickerEntry) {
    onPick(entry.build());
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a card</DialogTitle>
          <DialogDescription>
            Ready-made summaries, cards you point at your own data, and pieces for organising the
            screen.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="-mx-1 max-h-[60vh] px-1">
          <div className="space-y-5 pb-1">
            <Group
              title="Ready-made"
              blurb="Built into the app and wired to the pages they summarise."
              entries={readyMade}
              empty="None of the built-in cards are available to you."
              onChoose={choose}
            />
            <Group
              title="Build your own"
              blurb="Point one at a source, choose what it shows, and name it."
              entries={buildYourOwn}
              empty="You cannot query any data source, so there is nothing to build a card from."
              onChoose={choose}
            />
            <Group
              title="Layout"
              blurb="For arranging everything else."
              entries={layout}
              empty=""
              onChoose={choose}
            />
          </div>
        </ScrollArea>

        {/*
          Said once, here, rather than badged on nine entries: the "when
          relevant" badge above is about cards that hide THEMSELVES, and every
          card can be given a rule of its own afterwards. Without this line a
          user reads the badge as a property only ready-made cards can have.
        */}
        <p className="text-[11px] text-muted-foreground">
          Any card can be given a rule of its own afterwards — only show it to certain people, at
          certain times, or when it has something in it.
        </p>
      </ResponsiveDialogContent>
    </Dialog>
  );
}

/* ── groups ───────────────────────────────────────────────────────── */

function Group({
  title,
  blurb,
  entries,
  empty,
  onChoose,
}: {
  title: string;
  blurb: string;
  entries: PickerEntry[];
  /** What to say when the group is empty. "" means say nothing and draw nothing. */
  empty: string;
  onChoose: (entry: PickerEntry) => void;
}) {
  if (entries.length === 0 && empty === "") return null;
  const headingId = `picker-group-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;

  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {title}
      </h3>
      <p className="mt-0.5 text-[11px] text-muted-foreground/70">{blurb}</p>
      {entries.length === 0 ? (
        <p className="mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                onClick={() => onChoose(entry)}
                className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {entry.preview}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-foreground">{entry.name}</span>
                    {entry.badge && (
                      <span className="rounded bg-muted px-1 py-px text-[10px] font-normal text-muted-foreground">
                        {entry.badge}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {entry.description}
                  </span>
                  {entry.note && (
                    <span className="mt-1 block text-[10px] text-muted-foreground/70">
                      {entry.note}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── starting configs ─────────────────────────────────────────────── */

/**
 * The query a brand-new data card starts with: everything, newest first, eight
 * rows.
 *
 * `scope: "team"` rather than `"mine"` because `mine` NARROWS and a card that
 * starts narrowed shows a person less than they expected on the first render,
 * which reads as the card not working. The source's own row scope still applies
 * either way — nobody sees a row here they could not open on its own page.
 */
function startingQuery(source: SourceDef): CardQuery {
  return {
    source: source.id,
    filters: [],
    scope: "team",
    period: "all",
    limit: 8,
  };
}

/**
 * The catalogue's suggested columns, minus any this viewer is not trusted with.
 *
 * Deal value is the case that forces the filter: `leads.defaultColumns` includes
 * it, and it carries its own permission. Starting a card with a column the
 * compiler will silently drop leaves a heading with an empty column under it.
 */
function startingColumns(source: SourceDef, sets: EditorAccessSets): string[] {
  const allowed = new Set(usableFields(source, sets).map((field) => field.key));
  return source.defaultColumns.filter((key) => allowed.has(key)).slice(0, LIMITS.columnsPerCard);
}

type EditorAccessSets = { permissions: ReadonlySet<string>; modules: ReadonlySet<string> };

/**
 * The first field of a source this viewer may group a chart by.
 *
 * Mirrors `resolveField(…, "group")` in compile.ts exactly — groupable must be
 * TRUE (not merely un-set), and a composite is display-only, so grouping by one
 * would produce a chart with no slices. Offering a group-by the compiler would
 * refuse is the same class of mistake as offering a card the renderer would.
 */
function firstGroupableKey(source: SourceDef, sets: EditorAccessSets): string | null {
  const field = usableFields(source, sets).find((f) => f.groupable === true && !f.paths);
  return field ? field.key : null;
}

/* ── sketches ─────────────────────────────────────────────────────── */

/*
 * Static class strings only. Tailwind scans source TEXT, so a computed
 * `w-${n}/4` is never generated into the stylesheet and the sketch collapses to
 * nothing — the same rule DashboardGrid and cards/placement.ts spell out for column
 * spans, and it bites harder here because a missing preview looks like a design
 * choice rather than a bug.
 */

const SKETCH_BOX =
  "flex h-14 w-20 shrink-0 flex-col justify-center gap-1 rounded-md border border-border bg-muted/40 p-2";

const WIDTH: Record<"full" | "wide" | "half" | "third", string> = {
  full: "w-full",
  wide: "w-3/4",
  half: "w-1/2",
  third: "w-1/3",
};

const TONE: Record<"strong" | "soft" | "accent", string> = {
  strong: "bg-foreground/50",
  soft: "bg-foreground/20",
  accent: "bg-primary/50",
};

function Bar({
  width = "full",
  tone = "soft",
  className,
}: {
  width?: keyof typeof WIDTH;
  tone?: keyof typeof TONE;
  className?: string;
}) {
  return <span className={cn("block h-1.5 rounded-full", WIDTH[width], TONE[tone], className)} />;
}

/** Every sketch is decoration; the entry's name and description carry the meaning. */
function Sketch({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(SKETCH_BOX, className)}>
      {children}
    </span>
  );
}

function BuiltinSketch() {
  return (
    <Sketch>
      <Bar width="half" tone="strong" />
      <Bar width="full" />
      <Bar width="wide" />
    </Sketch>
  );
}

function StatSketch() {
  return (
    <Sketch>
      <span className="block h-4 w-1/2 rounded bg-foreground/50" />
      <Bar width="wide" />
    </Sketch>
  );
}

function ListSketch() {
  return (
    <Sketch className="justify-start">
      {["a", "b", "c"].map((row) => (
        <span key={row} className="flex items-center gap-1">
          <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
          <Bar width="full" />
        </span>
      ))}
    </Sketch>
  );
}

const CHART_BARS: readonly string[] = ["h-3", "h-6", "h-4", "h-8"];

function ChartSketch() {
  return (
    <Sketch className="flex-row items-end justify-center gap-1.5">
      {CHART_BARS.map((height) => (
        <span key={height} className={cn("w-2 rounded-sm bg-primary/50", height)} />
      ))}
    </Sketch>
  );
}

function GaugeSketch() {
  return (
    <Sketch className="items-center justify-center">
      {/* A ring three-quarters of the way round, drawn with borders — no SVG and
          no dependency for a picture the size of a thumbnail. */}
      <span className="block size-8 rounded-full border-4 border-primary/50 border-t-foreground/15" />
    </Sketch>
  );
}

function NoteSketch() {
  return (
    <Sketch>
      <Bar width="full" />
      <Bar width="full" />
      <Bar width="half" />
    </Sketch>
  );
}

function HeadingSketch() {
  return (
    <Sketch className="justify-center">
      <Bar width="third" tone="strong" />
      <span className="block h-px w-full bg-border" />
    </Sketch>
  );
}

function ButtonSketch() {
  return (
    <Sketch className="items-center justify-center">
      <span className="flex w-full items-center gap-1.5 rounded-md border border-border bg-card px-1.5 py-1">
        <span className="size-2.5 shrink-0 rounded bg-primary/50" />
        <Bar width="full" />
      </span>
    </Sketch>
  );
}

function GridSketch() {
  return (
    <Sketch className="justify-center">
      <span className="grid grid-cols-2 gap-1">
        {["a", "b", "c", "d"].map((cell) => (
          <span key={cell} className="block h-3 rounded-sm bg-foreground/20" />
        ))}
      </span>
    </Sketch>
  );
}

function StackSketch() {
  return (
    <Sketch>
      <span className="block h-2.5 w-full rounded-sm bg-foreground/20" />
      <span className="block h-2.5 w-full rounded-sm bg-foreground/20" />
      <span className="block h-2.5 w-full rounded-sm bg-foreground/20" />
    </Sketch>
  );
}
