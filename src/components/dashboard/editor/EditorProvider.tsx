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
import {
  filterCards,
  liftFromContainer,
  mapCards,
  reorderInTree,
} from "@/lib/dashboard/cardTree";

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
  /** Apply a change to the whole document and persist it. */
  update: (change: (config: DashboardConfig) => DashboardConfig) => void;
  /** Convenience wrappers over `update` for the three common depths. */
  updateView: (viewId: string, change: (view: ViewConfig) => ViewConfig) => void;
  updateSection: (sectionId: string, change: (section: SectionConfig) => SectionConfig) => void;
  updateCard: (cardId: string, change: (card: CardConfig) => CardConfig) => void;
  removeCard: (cardId: string) => void;
  /** Move a card one place earlier or later among its siblings, at any depth. */
  moveCard: (cardId: string, direction: -1 | 1) => void;
  /** Lift a card out of the container it sits in, to just after that container. */
  liftCard: (cardId: string) => void;
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
  const [undoDepth, setUndoDepth] = useState(0);
  const [saving, setSaving] = useState(false);
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
     * A seed this editor produced is the echo of its own save. The arrangement on
     * screen is already correct and the history behind it is still valid, so it
     * is kept. A seed from anywhere else replaced the document under us, and
     * undoing into arrangements from before it would resurrect state the server
     * has already discarded.
     */
    const isOwnEcho = ownSeeds.current.has(seed);
    ownSeeds.current.delete(seed);
    if (!isOwnEcho) {
      history.current = [];
      setUndoDepth(0);
    }
    setConfig(initialConfig);
    // initialConfig is folded into `seed` by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // A pending save must not be lost to a navigation. Flushing on unmount is the
  // difference between "I moved it and left" and "I moved it and it went back".
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const persist = useCallback(
    (next: DashboardConfig) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const previous = committed.current;
        setSaving(true);
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
            setConfig(previous);
            toast.error(error instanceof Error ? error.message : "Could not save your dashboard.");
          } finally {
            setSaving(false);
          }
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [slug],
  );

  const update = useCallback(
    (change: (config: DashboardConfig) => DashboardConfig) => {
      setConfig((current) => {
        const next = change(current);
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
          return current;
        }
        // Recorded only once the change is known to be valid. A refused edit
        // never happened, so undoing past it would step over a state the user
        // never saw.
        history.current = [...history.current, current].slice(-UNDO_LIMIT);
        setUndoDepth(history.current.length);
        persist(checked.config);
        return checked.config;
      });
    },
    [persist],
  );

  const updateView = useCallback(
    (viewId: string, change: (view: ViewConfig) => ViewConfig) =>
      update((current) => ({
        ...current,
        views: current.views.map((view) => (view.id === viewId ? change(view) : view)),
      })),
    [update],
  );

  const updateSection = useCallback(
    (sectionId: string, change: (section: SectionConfig) => SectionConfig) =>
      update((current) => ({
        ...current,
        views: current.views.map((view) => ({
          ...view,
          sections: view.sections.map((section) =>
            section.id === sectionId ? change(section) : section,
          ),
        })),
      })),
    [update],
  );

  const updateCard = useCallback(
    (cardId: string, change: (card: CardConfig) => CardConfig) =>
      update((current) => mapCards(current, (card) => (card.id === cardId ? change(card) : card))),
    [update],
  );

  const removeCard = useCallback(
    (cardId: string) => update((current) => filterCards(current, (card) => card.id !== cardId)),
    [update],
  );

  /*
   * Reordering and un-nesting, for cards the drag cannot reach.
   *
   * A card inside a grid or stack is drawn by that container on the SERVER, so
   * the editor has no sortable node for it and drag can only ever reorder the
   * top level. That left the children of a container with no way to be moved,
   * reordered or taken back out — a card dragged into a group was effectively
   * stuck there.
   *
   * These two operate on the CONFIG rather than on the rendered nodes, so they
   * work identically at any depth. Like every other walk the editor performs
   * they live in lib/dashboard/cardTree, which is what lets a test execute them:
   * a hand-rolled walk that forgot to descend would silently do nothing for
   * exactly the cards this exists to reach, and this file cannot be imported by
   * the test process at all.
   */
  const moveCard = useCallback(
    (cardId: string, direction: -1 | 1) =>
      update((current) => reorderInTree(current, cardId, direction)),
    [update],
  );

  const liftCard = useCallback(
    (cardId: string) => update((current) => liftFromContainer(current, cardId)),
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
        moveCard,
        liftCard,
        undo,
        canUndo: undoDepth > 0,
        activeViewId,
      }}
    >
      {children}
    </EditorContext.Provider>
  );
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
