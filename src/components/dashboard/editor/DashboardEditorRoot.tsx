"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Plus, Settings2, Trash2, Code2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CardConfig, DashboardConfig, ViewConfig } from "@/lib/dashboard/config";
import { LIMITS, slugify } from "@/lib/dashboard/config";
import { findCardInTree } from "@/lib/dashboard/cardTree";
import { DashboardEditorProvider, useEditor, newId } from "./EditorProvider";
import DashboardCanvas, { type CardSlots } from "./DashboardCanvas";
import CardPicker, { type EditorAccess } from "./CardPicker";
import CardBuilder from "./CardBuilder";
import RawEditor from "./RawEditor";

/**
 * Everything the browser owns about one dashboard: the edit toggle, the tab
 * strip, the canvas, and the dialogs.
 *
 * The server hands down a config and a map of rendered card nodes; this decides
 * what to draw and what a drag does. It is one component around the whole
 * screen rather than several small islands because the tab strip, the canvas and
 * the dialogs all read and write the SAME document — a card dialog four levels
 * down changes the config the tab strip is rendering from — and islands would
 * mean either duplicating that state or lifting it into a router round trip on
 * every keystroke.
 *
 * ── THE ACTIVE TAB IS STILL A URL IN READ MODE ──────────────────────────────
 *
 * Read mode keeps tabs as links, because a tab is a place people bookmark. Edit
 * mode switches them to local state, because a full navigation between every tab
 * while arranging would re-run every card's query and lose the drag context —
 * and nobody bookmarks a tab mid-edit.
 */
export default function DashboardEditorRoot({
  slug,
  dashboardId,
  updatedAt,
  config,
  views,
  activeViewId,
  slots,
  canEdit,
  access,
}: {
  slug: string;
  dashboardId: string | null;
  /** The row's revision, which every autosave is fenced against. Null until the
   *  dashboard has been materialised — see the provider. */
  updatedAt: string | null;
  config: DashboardConfig;
  /** The views this viewer may see, already filtered by the server. */
  views: ViewConfig[];
  activeViewId: string | null;
  slots: CardSlots;
  /**
   * False for a dashboard the viewer may look at but not change. There is no
   * such case today — dashboards are personal — but the editor must not be the
   * thing that assumes so, because the first shared dashboard would then arrive
   * fully editable by everyone who could open it.
   */
  canEdit: boolean;
  /** Resolved once on the server and handed down — see CardPicker's doc comment. */
  access: EditorAccess;
}) {
  return (
    <DashboardEditorProvider
      /*
       * One editing session per DOCUMENT. Without the key, navigating from one
       * dashboard to another reuses this provider, and it would carry the other
       * document's revision, undo history and already-materialised flag across —
       * so the first save on the new dashboard would fence against a revision
       * belonging to a different row, and undo would step into arrangements that
       * were never on this screen.
       */
      key={slug}
      slug={slug}
      initialConfig={config}
      dashboardId={dashboardId}
      initialUpdatedAt={updatedAt}
      activeViewId={activeViewId}
    >
      <Inner
        views={views}
        activeViewId={activeViewId}
        slots={slots}
        canEdit={canEdit}
        access={access}
      />
    </DashboardEditorProvider>
  );
}

function Inner({
  views,
  activeViewId,
  slots,
  canEdit,
  access,
}: {
  views: ViewConfig[];
  activeViewId: string | null;
  slots: CardSlots;
  canEdit: boolean;
  access: EditorAccess;
}) {
  const { config, editing, setEditing, saving, update, updateView, undo, canUndo } = useEditor();

  /*
   * Ctrl/Cmd+Z while editing.
   *
   * Bound only while `editing`, so it cannot swallow the browser's own undo on a
   * page where there is nothing to undo. Skipped when the event came from a text
   * field: inside an input, Ctrl+Z means "undo my typing", and hijacking that to
   * revert the whole card would be worse than not offering it.
   */
  useEffect(() => {
    if (!editing || !canEdit) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "z" && event.key !== "Z") return;
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.shiftKey) return; // redo, which does not exist yet
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, canEdit, undo]);
  const [localViewId, setLocalViewId] = useState<string | null>(activeViewId);
  const [pickerSection, setPickerSection] = useState<string | null>(null);
  const [builderCardId, setBuilderCardId] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState(false);

  /*
   * In edit mode every tab is shown, hidden ones included.
   *
   * A tab you hid behind a rule is precisely the one you most need to reach in
   * order to change that rule, and the read-mode filter would make it
   * unreachable from the only screen that can edit it. The alternative — an
   * escape hatch elsewhere in settings — is a second place to manage tabs.
   */
  const shown = editing ? config.views : views;
  const active = shown.find((view) => view.id === localViewId) ?? shown[0] ?? null;

  // findCardInTree, not a local search: the settings button the canvas offers is
  // now drawn for DESCENDANTS of a container, not only its immediate children,
  // so a lookup that stopped one level short would open an empty dialog on
  // exactly the cards that button was added to reach.
  const builderCard = builderCardId ? findCardInTree(config, builderCardId) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {shown.map((view) => (
            <button
              key={view.id}
              type="button"
              onClick={() => setLocalViewId(view.id)}
              aria-current={view.id === active?.id ? "page" : undefined}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                view.id === active?.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {view.title}
              {editing && view.visibility && view.visibility.length > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">(conditional)</span>
              )}
            </button>
          ))}
          {editing && config.views.length < LIMITS.viewsPerDashboard && (
            <button
              type="button"
              onClick={() => {
                const view = blankView(config);
                update((current) => ({ ...current, views: [...current.views, view] }));
                setLocalViewId(view.id);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Plus className="size-3.5" />
              Tab
            </button>
          )}
        </div>

        {saving && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Saving
          </span>
        )}

        {canEdit && editing && (
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            title="Undo the last change (Ctrl+Z)"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Undo2 className="size-3.5" />
            Undo
          </button>
        )}

        {canEdit && editing && (
          <button
            type="button"
            onClick={() => setRawOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Code2 className="size-3.5" />
            Code
          </button>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            aria-pressed={editing}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
              editing
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {editing ? <Check className="size-3.5" /> : <Settings2 className="size-3.5" />}
            {editing ? "Done" : "Customise"}
          </button>
        )}
      </div>

      {editing && active && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2">
          <label className="sr-only" htmlFor={`tab-title-${active.id}`}>
            Tab name
          </label>
          <input
            id={`tab-title-${active.id}`}
            value={active.title}
            onChange={(event) =>
              updateView(active.id, (current) => ({
                ...current,
                title: event.target.value,
                // The address follows the name, because a tab whose name and URL
                // disagree is confusing in exactly the place people share links.
                path: slugify(event.target.value || "tab"),
              }))
            }
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs text-foreground outline-none focus:border-primary/40"
          />
          <label className="sr-only" htmlFor={`tab-cols-${active.id}`}>
            Columns
          </label>
          <select
            id={`tab-cols-${active.id}`}
            value={active.columns}
            onChange={(event) =>
              updateView(active.id, (current) => ({
                ...current,
                columns: Number(event.target.value) as 1 | 2 | 3 | 4,
              }))
            }
            className="rounded border border-border bg-card px-1.5 py-1 text-xs text-muted-foreground"
          >
            {([1, 2, 3, 4] as const).map((n) => (
              <option key={n} value={n}>
                {n} column{n > 1 ? "s" : ""}
              </option>
            ))}
          </select>
          {config.views.length > 1 && (
            <button
              type="button"
              aria-label="Delete this tab"
              onClick={() => {
                update((current) => ({
                  ...current,
                  views: current.views.filter((view) => view.id !== active.id),
                }));
                setLocalViewId(null);
              }}
              className="text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {active ? (
        <DashboardCanvas
          view={active}
          slots={slots}
          onConfigure={setBuilderCardId}
          onAddCard={setPickerSection}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium text-foreground">Nothing to show here yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {canEdit
              ? "Use Customise to add a tab."
              : "Every tab on this dashboard is hidden by one of its own rules."}
          </p>
        </div>
      )}

      <CardPicker
        open={pickerSection !== null}
        onOpenChange={(open) => !open && setPickerSection(null)}
        access={access}
        onPick={(card) => {
          const sectionId = pickerSection;
          if (!sectionId) return;
          update((current) => ({
            ...current,
            views: current.views.map((view) => ({
              ...view,
              sections: view.sections.map((section) =>
                section.id === sectionId ? { ...section, cards: [...section.cards, card] } : section,
              ),
            })),
          }));
          setPickerSection(null);
          // Straight into the settings for anything that needs configuring. A
          // freshly added list card with no source is an empty box, and an empty
          // box is how someone concludes the button did not work.
          if (needsSetup(card)) setBuilderCardId(card.id);
        }}
      />

      <CardBuilder
        card={builderCard}
        open={builderCard !== null}
        onOpenChange={(open) => !open && setBuilderCardId(null)}
        access={access}
      />

      <RawEditor open={rawOpen} onOpenChange={setRawOpen} />
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────── */

function blankView(config: DashboardConfig): ViewConfig {
  // Names have to be unique enough that the slug does not collide, since two
  // tabs sharing an address is a structural error the parser refuses — which
  // would show up as "could not save" on a button press that looks harmless.
  const n = config.views.length + 1;
  const title = `Tab ${n}`;
  return {
    id: newId("view"),
    title,
    path: slugify(`${title}-${newId("view").slice(-4)}`),
    columns: 3,
    sections: [{ id: newId("section"), columnSpan: 3, cards: [] }],
  };
}

/** A card that would render as an empty box until somebody tells it what to show. */
function needsSetup(card: CardConfig): boolean {
  return card.type !== "builtin" && card.type !== "heading";
}

