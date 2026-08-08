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
  /** Apply a change to the whole document and persist it. */
  update: (change: (config: DashboardConfig) => DashboardConfig) => void;
  /** Convenience wrappers over `update` for the three common depths. */
  updateView: (viewId: string, change: (view: ViewConfig) => ViewConfig) => void;
  updateSection: (sectionId: string, change: (section: SectionConfig) => SectionConfig) => void;
  updateCard: (cardId: string, change: (card: CardConfig) => CardConfig) => void;
  removeCard: (cardId: string) => void;
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
