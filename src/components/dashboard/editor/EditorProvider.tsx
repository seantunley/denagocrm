"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  parseConfigStrict,
  type CardConfig,
  type DashboardConfig,
  type SectionConfig,
  type ViewConfig,
} from "@/lib/dashboard/config";
import { saveDashboardConfig, takeControl } from "@/app/actions/dashboardConfig";

/**
 * The editing session: one working copy of the config, and one way to save it.
 *
 * ── WHY A PROVIDER RATHER THAN PROPS ────────────────────────────────────────
 *
 * Every editing surface changes the SAME document from a different depth — the
 * toolbar adds a tab, a section header sets a column span, a card's dialog
 * rewrites one leaf four levels down, a drag moves a card between two sections.
 * Threading `config` and an `onChange` through all of that means every
 * intermediate component takes props it does not use and forwards them
 * correctly, and the first one that forgets produces an edit that appears to
 * work and is gone on reload.
 *
 * So there is one mutator, `update`, which takes a function over the whole
 * config. Callers describe the change; nothing else has to know where in the
 * tree it happened.
 *
 * ── SAVING ──────────────────────────────────────────────────────────────────
 *
 * Immediate and optimistic, the same choice DashboardGrid documents: a drop or a
 * dialog's Done is already an unambiguous commit gesture, and an explicit Save
 * button would create the one genuinely bad state — a screen showing an
 * arrangement the database does not have, on the page people are most likely to
 * navigate away from without looking back.
 *
 * Saves are COALESCED. Dragging a card through four sections fires four config
 * changes in a second, and four overlapping writes of a whole JSON document is
 * both wasteful and a way to have the second-to-last one land last. A short
 * trailing debounce means the server sees the arrangement the user stopped on.
 *
 * ── TAKING CONTROL ──────────────────────────────────────────────────────────
 *
 * A user with no stored dashboard is editing a config that was generated, not
 * read. The first change has to materialise it before anything can be written
 * to it. That happens once, transparently, on the first edit — asking someone to
 * press "Take control of this dashboard" before they may move a card is a
 * question about our data model, not about anything they wanted to do.
 */

type EditorState = {
  /** The working config. Always what is drawn. */
  config: DashboardConfig;
  editing: boolean;
  setEditing: (value: boolean) => void;
  /** True while a save is in flight, for the "Saving…" hint. */
  saving: boolean;
  /**
   * Apply a change to the whole document and persist it.
   *
   * A change that returns the config it was given, unchanged and by reference,
   * is a no-op: nothing is validated, recorded or saved. Callers driven by
   * pointer movement should take that path rather than returning a new object
   * describing the same arrangement.
   *
   * `gesture` groups consecutive changes into ONE undo step — see the note
   * beside `gesture` in the provider.
   */
  update: (change: (config: DashboardConfig) => DashboardConfig, gesture?: string) => void;
  /** Convenience wrappers over `update` for the three common depths. */
  updateView: (viewId: string, change: (view: ViewConfig) => ViewConfig, gesture?: string) => void;
  updateSection: (
    sectionId: string,
    change: (section: SectionConfig) => SectionConfig,
    gesture?: string,
  ) => void;
  updateCard: (
    cardId: string,
    change: (card: CardConfig) => CardConfig,
    gesture?: string,
  ) => void;
  removeCard: (cardId: string) => void;
  /** Step back one change. No-op when there is nothing to step back to. */
  undo: () => void;
  /** Whether there is anything to undo, so the control can disable itself. */
  canUndo: boolean;
  /** Which view is being edited, so dialogs know where to put a new card. */
  activeViewId: string | null;
};

const EditorContext = createContext<EditorState | null>(null);

export function useEditor(): EditorState {
  const value = useContext(EditorContext);
  // A hard throw rather than a null-returning hook. Every consumer of this
  // dereferences `config` immediately, so a silent null would surface as a
  // property-of-undefined crash three components away from the missing provider.
  if (!value) throw new Error("useEditor must be used inside a DashboardEditorProvider");
  return value;
}

/** How long to wait for the user to stop before writing. */
const SAVE_DEBOUNCE_MS = 600;

/** How many steps back the editor remembers. See the note beside `history`. */
const UNDO_LIMIT = 25;

/** How many un-echoed saves to remember. See the note beside `ownSeeds`. */
const OWN_SEED_LIMIT = 8;

export function DashboardEditorProvider({
  slug,
  initialConfig,
  /** Null when this dashboard has never been saved — see "taking control". */
  dashboardId,
  activeViewId,
  children,
}: {
  slug: string;
  initialConfig: DashboardConfig;
  dashboardId: string | null;
  activeViewId: string | null;
  children: React.ReactNode;
}) {
  const [config, setConfig] = useState<DashboardConfig>(initialConfig);
  /*
   * The same config, readable synchronously.
   *
   * `update` used to do its work inside a `setConfig(current => …)` updater,
   * which put four side effects — a toast, an undo push, a `setUndoDepth` and a
   * scheduled save — inside a function React requires to be PURE. React is
   * allowed to call an updater more than once for a single update, and does when
   * a render is interrupted and replayed; saves run inside `startTransition`, so
   * during a drag there is always a transition in flight to interrupt one. Each
   * replay pushed another undo entry and called `setUndoDepth` with a new value
   * DURING the render phase, which schedules another render, which replays the
   * updater again. That is a loop, and React ends it by throwing "Too many
   * re-renders" — a render-phase throw, so it reached the route's error boundary
   * and the user got an error page. It took a lot of dragging to hit and none to
   * explain afterwards, because nothing about the arrangement was wrong.
   *
   * So `update` now reads from here, computes everything itself, and hands
   * `setConfig` a finished value. Updated synchronously on every change, which
   * matters because dragover fires several times between renders and each one
   * has to build on the last.
   */
  const configRef = useRef<DashboardConfig>(initialConfig);
  const [editing, setEditing] = useState(false);
  /*
   * UNDO.
   *
   * The editor could drag, resize and delete, and had no way back from any of
   * them. Saving is immediate and debounced by design — there is no Save button
   * to not press — so an accidental delete was already written by the time the
   * user noticed, and rebuilding a card someone spent ten minutes configuring is
   * how people learn not to experiment with their own dashboard.
   *
   * The stack holds CONFIGS, not diffs. A config is small, already immutable by
   * convention here, and every mutation funnels through `update`, so pushing the
   * previous one is both cheap and impossible to forget for a new operation.
   *
   * Bounded, because a long editing session should not accumulate unboundedly in
   * memory — and because "undo the last twenty-five things" is well past the
   * point anyone is still reasoning about what they did.
   */
  const history = useRef<DashboardConfig[]>([]);
  /*
   * Seeds this editor itself caused.
   *
   * Every successful save calls revalidatePath("/"), so the server sends the
   * config straight back — and the re-seed effect below treats any changed seed
   * as a foreign config and clears the undo history. That is the correct
   * response to somebody else's change and completely wrong for the echo of the
   * edit just made: it wiped the history roughly 600ms after every edit, so undo
   * only ever covered the window BEFORE the autosave landed.
   *
   * Which is the opposite of why undo exists. The whole reason is that saving is
   * immediate, so an accidental delete is already persisted by the time it is
   * noticed — precisely the state that had no history left.
   *
   * Seeds are matched by VALUE, because the object that comes back from the
   * server is never the object that was sent.
   */
  const ownSeeds = useRef<Set<string>>(new Set());
  /*
   * The gesture the last change belonged to, so a gesture is ONE undo step.
   *
   * Undo was per-change, and several editing actions are not one change. A drag
   * fires a dragover on every pointer movement and each one reordered the
   * config; a group's name field fires on every keystroke. So one drag across a
   * section left fifteen entries on a twenty-five entry stack — undo took
   * fifteen presses to reverse one motion, and two drags had pushed everything
   * else off the end.
   *
   * Consecutive changes carrying the same gesture id push nothing: the state
   * from before the gesture began is already on the stack, and that is the one
   * to come back to. Any change without a gesture, or with a different one,
   * clears it and pushes normally.
   */
  const gesture = useRef<string | null>(null);
  const [undoDepth, setUndoDepth] = useState(0);
  const [saving, setSaving] = useState(false);
  /*
   * Saves that have left but not landed. Not the `saving` flag: this is read
   * inside the re-seed effect, which must see the value as it is at that
   * instant rather than as it was when the effect closed over its render.
   */
  const inFlight = useRef(0);
  const [, startTransition] = useTransition();

  // The last arrangement the server accepted, so a refused save has somewhere to
  // roll back to. Not state: rolling back must not itself schedule a save.
  const committed = useRef<DashboardConfig>(initialConfig);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const materialised = useRef<boolean>(dashboardId !== null);

  /*
   * Re-seed when the SERVER sends a different config.
   *
   * Compared by VALUE, not by object identity, and that is load-bearing for the
   * same reason it was in DashboardGrid: `initialConfig` is a fresh object on
   * every render of the page, so an identity-compared effect would fire during
   * the save transition — while the server still holds the previous config — and
   * throw away the edit the user just made.
   */
  const seed = JSON.stringify(initialConfig);
  const seenSeed = useRef(seed);
  useEffect(() => {
    if (seenSeed.current === seed) return;
    seenSeed.current = seed;
    committed.current = initialConfig;

    /*
     * A seed this editor produced is the ECHO OF ITS OWN SAVE, and re-seeding
     * from it is how cards jumped back.
     *
     * Every save calls revalidatePath("/"), so the arrangement comes back around
     * a second later. This effect adopted it unconditionally — and by then the
     * user has usually moved something else, because a second is a long time
     * mid-drag. Adopting the echo threw that newer arrangement off the screen and
     * put back the one from before it. The pending save then wrote the newer
     * arrangement anyway, so the database and the screen disagreed until its own
     * echo arrived and moved everything a second time. From the outside: cards
     * snapping back to where they were, then sometimes forward again.
     *
     * An echo can never be news. The screen is already this arrangement or ahead
     * of it, so the seed is recorded and nothing is touched.
     */
    if (ownSeeds.current.has(seed)) {
      ownSeeds.current.delete(seed);
      return;
    }

    /*
     * Not ours — the document was changed somewhere else, another tab or another
     * session. Worth adopting, but not over the top of unsaved work: a change in
     * flight, or one still sitting in the debounce, is something the user made
     * and has not been told is at risk. Our own save is moments away and will
     * settle it; skipping here costs at most one stale render of somebody else's
     * change, which the echo of that save corrects.
     */
    if (inFlight.current > 0 || timer.current !== null) return;

    // A foreign config replaced the document. Undoing into arrangements from
    // before it would resurrect state the server has already discarded.
    history.current = [];
    gesture.current = null;
    setUndoDepth(0);
    configRef.current = initialConfig;
    setConfig(initialConfig);
    // initialConfig is folded into `seed` by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  /*
   * The arrangement waiting out the debounce, if any.
   *
   * Kept so it can be written on unmount. The cleanup below used to clear the
   * timer and stop there, under a comment claiming it flushed — so an edit made
   * within the debounce window of navigating away was simply dropped, and came
   * back to the previous arrangement on return. That is one of the ways "I moved
   * it and it went back" happens, and the least visible: nothing fails, the save
   * never happens at all.
   */
  const pending = useRef<DashboardConfig | null>(null);

  useEffect(() => {
    const slugAtMount = slug;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const unsaved = pending.current;
      pending.current = null;
      /*
       * Fired without awaiting and without touching state: there is no component
       * left to tell. A refusal here is silent, which is the right trade — the
       * alternative is losing the edit outright, and the arrangement is re-read
       * from the server on the way back in either way.
       */
      if (unsaved) void saveDashboardConfig(slugAtMount, unsaved);
    };
  }, [slug]);

  const persist = useCallback(
    (next: DashboardConfig) => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = next;
      timer.current = setTimeout(() => {
        timer.current = null;
        pending.current = null;
        const previous = committed.current;
        setSaving(true);
        inFlight.current += 1;
        startTransition(async () => {
          try {
            // Materialise a generated dashboard before its first write. Once,
            // and only for a dashboard that has never been stored.
            if (!materialised.current) {
              const claimed = await takeControl();
              if (claimed?.error) throw new Error(claimed.error);
              materialised.current = true;
            }
            const result = await saveDashboardConfig(slug, next);
            if (result?.error) throw new Error(result.error);
            committed.current = next;
            // The server will echo this back via revalidatePath. Remember it so
            // the re-seed below recognises it as ours and keeps the history.
            const seedKey = JSON.stringify(next);
            ownSeeds.current.add(seedKey);
            // Bounded. An echo that never arrives — a save that changed nothing
            // the server re-sends, a navigation before revalidation lands —
            // would otherwise leave its key here forever. A Set preserves
            // insertion order, so the oldest goes first.
            while (ownSeeds.current.size > OWN_SEED_LIMIT) {
              const oldest = ownSeeds.current.values().next().value;
              if (oldest === undefined) break;
              ownSeeds.current.delete(oldest);
            }
          } catch (error) {
            /*
             * Roll the SCREEN back, not just the record of what is saved.
             *
             * Leaving the failed arrangement on screen would be worse than
             * useless: the user would believe the change took, navigate away,
             * and come back to find it gone with no explanation. Putting the
             * cards back where they were is the only honest response to a
             * refusal.
             */
            configRef.current = previous;
            setConfig(previous);
            toast.error(error instanceof Error ? error.message : "Could not save your dashboard.");
          } finally {
            inFlight.current -= 1;
            setSaving(false);
          }
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [slug],
  );

  const update = useCallback(
    (change: (config: DashboardConfig) => DashboardConfig, gestureId?: string) => {
      const current = configRef.current;
      const next = change(current);

      /*
       * A change that hands back what it was given did not change anything.
       *
       * Dragover fires on every pointer movement and most of those events leave
       * the order exactly as it was. Taking the rest of this path for them meant
       * running the strict parser over the whole config, adding an undo entry
       * and queueing a write — dozens of times per drag, for one arrangement.
       * That is most of what made dragging feel heavy.
       */
      if (next === current) return;

      /*
       * Validate BEFORE persisting, with the same parser the action uses.
       *
       * The server would refuse this anyway, but a round trip later — after
       * the debounce, by which time the user has made three more edits and has
       * no idea which one was rejected. Checking here means the message names
       * the change that caused it, while they are still looking at it.
       */
      const checked = parseConfigStrict(next);
      if (!checked.ok) {
        toast.error(checked.error);
        return;
      }

      // Recorded only once the change is known to be valid. A refused edit
      // never happened, so undoing past it would step over a state the user
      // never saw. Within one gesture the pre-gesture state is already on the
      // stack, so there is nothing to add.
      if (!gestureId || gestureId !== gesture.current) {
        history.current = [...history.current, current].slice(-UNDO_LIMIT);
        setUndoDepth(history.current.length);
      }
      gesture.current = gestureId ?? null;

      configRef.current = checked.config;
      setConfig(checked.config);
      persist(checked.config);
    },
    [persist],
  );

  const updateView = useCallback(
    (viewId: string, change: (view: ViewConfig) => ViewConfig, gestureId?: string) =>
      update((current) => {
        const view = current.views.find((candidate) => candidate.id === viewId);
        if (!view) return current;
        const next = change(view);
        // Propagate "nothing changed" upwards rather than rebuilding the config
        // around an identical view — see the reference check in `update`.
        if (next === view) return current;
        return {
          ...current,
          views: current.views.map((candidate) => (candidate.id === viewId ? next : candidate)),
        };
      }, gestureId),
    [update],
  );

  const updateSection = useCallback(
    (sectionId: string, change: (section: SectionConfig) => SectionConfig, gestureId?: string) =>
      update(
        (current) => ({
          ...current,
          views: current.views.map((view) => ({
            ...view,
            sections: view.sections.map((section) =>
              section.id === sectionId ? change(section) : section,
            ),
          })),
        }),
        gestureId,
      ),
    [update],
  );

  const updateCard = useCallback(
    (cardId: string, change: (card: CardConfig) => CardConfig, gestureId?: string) =>
      update(
        (current) => mapCards(current, (card) => (card.id === cardId ? change(card) : card)),
        gestureId,
      ),
    [update],
  );

  const removeCard = useCallback(
    (cardId: string) => update((current) => filterCards(current, (card) => card.id !== cardId)),
    [update],
  );

  /**
   * Step back one change.
   *
   * Deliberately does NOT go through `update`: that would record the undo itself
   * as a change and the stack could never be emptied — the first undo would
   * become something to undo. It persists directly instead, which is the same
   * path every other edit takes to the server.
   */
  const undo = useCallback(() => {
    const previous = history.current[history.current.length - 1];
    if (!previous) return;
    history.current = history.current.slice(0, -1);
    setUndoDepth(history.current.length);
    // An undo ends whatever gesture was running, so the next change starts a new
    // step rather than folding itself into the one just reversed.
    gesture.current = null;
    configRef.current = previous;
    setConfig(previous);
    persist(previous);
  }, [persist]);

  return (
    <EditorContext.Provider
      value={{
        config,
        editing,
        setEditing,
        saving,
        update,
        updateView,
        updateSection,
        updateCard,
        removeCard,
        undo,
        canUndo: undoDepth > 0,
        activeViewId,
      }}
    >
      {children}
    </EditorContext.Provider>
  );
}

/* ── walking the card tree ────────────────────────────────────────── */

/*
 * Cards nest, so every edit to a card has to reach into containers as well as
 * into sections. These two are the only places that recursion is written, which
 * is deliberate: a second hand-rolled walk that forgot to descend into `grid`
 * would make editing a card inside a container silently do nothing.
 */

function mapCardTree(cards: CardConfig[], change: (card: CardConfig) => CardConfig): CardConfig[] {
  return cards.map((card) => {
    const mapped = change(card);
    if (mapped.type === "grid" || mapped.type === "stack") {
      return { ...mapped, cards: mapCardTree(mapped.cards, change) };
    }
    return mapped;
  });
}

function filterCardTree(cards: CardConfig[], keep: (card: CardConfig) => boolean): CardConfig[] {
  return cards.filter(keep).map((card) => {
    if (card.type === "grid" || card.type === "stack") {
      return { ...card, cards: filterCardTree(card.cards, keep) };
    }
    return card;
  });
}

export function mapCards(
  config: DashboardConfig,
  change: (card: CardConfig) => CardConfig,
): DashboardConfig {
  return {
    ...config,
    views: config.views.map((view) => ({
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        cards: mapCardTree(section.cards, change),
      })),
    })),
  };
}

export function filterCards(
  config: DashboardConfig,
  keep: (card: CardConfig) => boolean,
): DashboardConfig {
  return {
    ...config,
    views: config.views.map((view) => ({
      ...view,
      sections: view.sections.map((section) => ({
        ...section,
        cards: filterCardTree(section.cards, keep),
      })),
    })),
  };
}

/**
 * A short, unique id for a new view, section or card.
 *
 * `crypto.randomUUID` is available in every browser this app supports and does
 * not need a dependency. The prefix is there so a raw config is readable by a
 * person — an id that says `card-` is worth the eight characters when somebody
 * is looking at JSON trying to work out which entry is the one on screen.
 */
export function newId(prefix: "view" | "section" | "card"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
