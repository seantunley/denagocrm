"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type ClientRect,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actionResultTypes";
import type { HostId } from "@/lib/checklists/hosts";
import {
  CAPTURE_KINDS,
  CHECKLIST_LIMITS,
  isPhotoCapture,
  templateProblems,
  type CaptureKind,
  type ChecklistTemplateInput,
} from "@/lib/checklists/types";

/**
 * Configuring one list.
 *
 * ── THE DRAG RULES ARE INHERITED, NOT REDISCOVERED ──────────────────────────
 *
 * Every one of them comes from dashboard/editor/DashboardCanvas.tsx, where they
 * were paid for in bug reports. Read that file's header for the full account;
 * the short version, and why each applies here too:
 *
 *   LOCAL STATE drives the order. The rows are not re-fetched between a drop and
 *   a save, so a drop moves something immediately instead of appearing to do
 *   nothing until a round trip lands.
 *
 *   NO SORTING STRATEGY and NO LAYOUT ANIMATION. `animateLayoutChanges` is a
 *   separate mechanism from the strategy and defaults ON — left alone it sets
 *   state from a layout effect on every index change, which nested deep enough
 *   to reach React's update-depth limit and put an error page in front of the
 *   user. These rows are different heights (a description wraps, a photo step
 *   has extra controls), so a transform-based preview would also send them to
 *   visibly wrong places.
 *
 *   DROPPABLES ARE RE-MEASURED ALWAYS. A row changes height while you are
 *   dragging past it — switching a step to `photo` reveals two more fields — so
 *   a rectangle measured once is a rectangle that is wrong by the time it is
 *   used.
 *
 *   THE DOCUMENT IS EDITED ONCE, ON THE DROP. The fourth rule is the one that
 *   was REVERSED on evidence: reordering under the pointer meant two rows could
 *   swap forever, because taking the other one's index puts it back under a
 *   pointer that has not moved. So a drag moves a MARKER — the gap you can see
 *   is drawn rather than reflowed into existence — and the list itself changes
 *   exactly once, when you let go.
 *
 * ── WHY THE SAVE ACTION IS A PROP ───────────────────────────────────────────
 *
 * So this file has no idea which action files a template. The settings page owns
 * that import, which keeps the editor drawable in any other surface that grows a
 * need for it, and keeps this module free of the server graph.
 */

/* ── what is being edited ─────────────────────────────────────────────── */

export type EditorHost = { id: HostId; label: string; description: string };

export type EditorItem = {
  /** Stable across a drag. The database id for a saved step, a fresh one for a
   *  step that has never been saved — a row's identity cannot wait for a save. */
  key: string;
  id?: string;
  label: string;
  description: string;
  capture: CaptureKind;
  required: boolean;
  minPhotos: number;
  maxPhotos: number;
};

export type EditorTemplate = {
  id?: string;
  host: HostId;
  name: string;
  description: string;
  active: boolean;
  sortOrder: number;
  items: EditorItem[];
};

const CAPTURE_LABELS: Record<CaptureKind, string> = {
  photo: "Photo",
  photo_note: "Photo and a note",
  boolean: "Yes / no",
  text: "Words",
  number: "A number",
};

/** Module-level, so the snapshot is referentially stable across renders. */
const subscribeToNothing = () => () => {};
const getDocumentBody = () => document.body;

const NO_TRANSFORM: SortingStrategy = () => null;
const MEASURE_ALWAYS = { droppable: { strategy: MeasuringStrategy.Always } };

/**
 * Keep the drag label under the cursor.
 *
 * dnd-kit positions the overlay at the DRAGGED ELEMENT's origin plus the
 * pointer's delta, which is right when the overlay is a copy of the element and
 * wrong here, where it is a small label standing in for a full-width row. Grab a
 * row by its handle on the left and the label is drawn at the row's left edge —
 * correct, and not where the pointer is. Written out rather than taken from
 * @dnd-kit/modifiers, which this project does not depend on.
 */
const snapToCursor: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const grabbedAt = getEventCoordinates(activatorEvent);
  if (!grabbedAt) return transform;
  return {
    ...transform,
    x: transform.x + grabbedAt.x - draggingNodeRect.left - draggingNodeRect.width / 2,
    y: transform.y + grabbedAt.y - draggingNodeRect.top - draggingNodeRect.height / 2,
  };
};

/* ── pure list maths ──────────────────────────────────────────────────── */

/**
 * Where the dragged row would land, counted over the rows WITHOUT it.
 *
 * Counted that way because the dragged row is taken out of the flow and a marker
 * takes its place, so the list occupying space is exactly the list this index is
 * measured against. Counting over the full list was the dashboard's original
 * off-by-one, and it showed as the marker sitting one row from where the card
 * actually landed.
 */
export function dropIndex(
  keys: readonly string[],
  activeKey: string,
  overKey: string,
  containerId: string,
  draggedRect: ClientRect | null,
  overRect: ClientRect | null,
): number | null {
  const others = keys.filter((key) => key !== activeKey);
  if (overKey === containerId) return others.length;
  const index = others.indexOf(overKey);
  if (index === -1) return null;
  // Below the hovered row's midpoint means after it. Without this the marker can
  // only ever sit above a row, and the last position is unreachable except by
  // aiming at the empty space under the list.
  if (draggedRect && overRect) {
    const draggedCentre = draggedRect.top + draggedRect.height / 2;
    const overCentre = overRect.top + overRect.height / 2;
    if (draggedCentre > overCentre) return index + 1;
  }
  return index;
}

/** The list with one row moved to `index`, counted over the rows without it. */
export function moveTo<T extends { key: string }>(rows: readonly T[], key: string, index: number): T[] {
  const moving = rows.find((row) => row.key === key);
  if (!moving) return [...rows];
  const others = rows.filter((row) => row.key !== key);
  const at = Math.max(0, Math.min(index, others.length));
  return [...others.slice(0, at), moving, ...others.slice(at)];
}

/* ── the editor ───────────────────────────────────────────────────────── */

const LIST_ID = "checklist-items";

export default function TemplateEditor({
  hosts,
  template,
  save,
  remove,
}: {
  /** Only the hosts this viewer may configure — filtered by `usableHosts`. */
  hosts: EditorHost[];
  template: EditorTemplate;
  save: (id: string | null, input: ChecklistTemplateInput) => Promise<ActionResult>;
  remove?: (id: string) => Promise<ActionResult>;
}) {
  const [host, setHost] = useState<HostId>(template.host);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [active, setActive] = useState(template.active);
  const [items, setItems] = useState<EditorItem[]>(template.items);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeHeight, setActiveHeight] = useState<number | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  /*
   * The last thing the pointer was over, so a drop that lands outside every
   * droppable still goes where the marker promised. dnd-kit reports `over` as
   * null in that case, and dropping a row into nothing should not silently undo
   * the whole gesture.
   */
  const lastOver = useRef<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  /*
   * The overlay has to escape the page wrapper. globals.css gives every direct
   * child of `.denago-workspace` an entry animation with `animation-fill-mode:
   * both`, whose final frame is `transform: translateY(0)` — and a transform
   * other than `none` makes an element the containing block for every
   * position:fixed descendant. dnd-kit's overlay is position:fixed with
   * viewport-space coordinates, so without this portal the label is displaced by
   * the wrapper's own offset for the whole drag.
   *
   * Read through useSyncExternalStore rather than set from an effect: it is the
   * shape React provides for a value that simply does not exist on the server.
   */
  const overlayHost = useSyncExternalStore(subscribeToNothing, getDocumentBody, () => null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // A delay on touch, or the page cannot be scrolled past the list on a phone.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const keys = useMemo(() => items.map((item) => item.key), [items]);
  /*
   * Identity is load-bearing: dnd-kit compares this array BY IDENTITY in several
   * places to decide whether the list has changed. A fresh array each render
   * makes that comparison permanently true, so it answers "the list just
   * changed" continuously for a list that has not changed at all.
   */
  const sortableItems = useMemo(() => [...keys, LIST_ID], [keys]);
  const keySet = useMemo(() => new Set(keys), [keys]);

  /*
   * WHAT IS UNDER THE POINTER, not what is nearest the dragged thing.
   *
   * `closestCenter` measures from the dragged item's rectangle, and these rows
   * vary in height — a step with a long description is three times the height of
   * a bare one — so the nearest centre is regularly not the row being pointed
   * at. Rows beat the list container, which covers them: without that preference
   * the container wins on centre distance and every drag ends at the bottom.
   *
   * `closestCenter` stays as the fallback for the keyboard sensor, which has no
   * pointer for `pointerWithin` to test.
   */
  const collisionDetection = useCallback<CollisionDetection>(
    (args) => {
      const within = pointerWithin(args);
      const overRow = within.filter((collision) => keySet.has(String(collision.id)));
      if (overRow.length > 0) return overRow;
      if (within.length > 0) return within;
      return closestCenter(args);
    },
    [keySet],
  );

  function onDragStart(event: DragStartEvent) {
    // Measured once, from the rect dnd-kit already took, so the marker can be
    // exactly as tall as the row it stands in for and nothing below moves.
    setActiveHeight(event.active.rect.current.initial?.height ?? null);
    setActiveKey(String(event.active.id));
  }

  function endDrag() {
    lastOver.current = null;
    setActiveKey(null);
    setActiveHeight(null);
    setPreview(null);
  }

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const dragged = String(active.id);
    const overId = String(over.id);
    if (dragged === overId) return;
    lastOver.current = overId;
    const next = dropIndex(
      keys,
      dragged,
      overId,
      LIST_ID,
      active.rect.current.translated,
      over.rect,
    );
    // Only when it actually moved. Dragover fires on every pointer movement and
    // most of those events point at the same gap as the last one.
    setPreview((currentValue) => (currentValue === next ? currentValue : next));
  }

  function onDragEnd(event: DragEndEvent) {
    const dragged = String(event.active.id);
    const overId = event.over ? String(event.over.id) : lastOver.current;
    const index = preview;
    endDrag();
    if (!overId || overId === dragged || index === null) return;
    // One drag, one change to the list.
    setItems((currentItems) => moveTo(currentItems, dragged, index));
    setSaved(null);
  }

  /* ── editing rows ─────────────────────────────────────────────────── */

  function patch(key: string, change: Partial<EditorItem>) {
    setItems((currentItems) =>
      currentItems.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
    setSaved(null);
  }

  function addItem() {
    if (items.length >= CHECKLIST_LIMITS.itemsPerTemplate) return;
    setItems((currentItems) => [
      ...currentItems,
      {
        // Minted in an event handler, never in a render — a render-time UUID
        // differs between the server and the client and makes the whole subtree
        // a hydration mismatch.
        key: crypto.randomUUID(),
        label: "",
        description: "",
        capture: "photo",
        required: true,
        minPhotos: 1,
        maxPhotos: 1,
      },
    ]);
    setSaved(null);
  }

  function dropItem(key: string) {
    setItems((currentItems) => currentItems.filter((item) => item.key !== key));
    setSaved(null);
  }

  function build(): ChecklistTemplateInput {
    return {
      host,
      name: name.trim(),
      description: description.trim() || undefined,
      active,
      sortOrder: template.sortOrder,
      items: items.map((item, index) => ({
        id: item.id,
        label: item.label.trim(),
        description: item.description.trim() || undefined,
        capture: item.capture,
        required: item.required,
        minPhotos: item.minPhotos,
        maxPhotos: item.maxPhotos,
        sortOrder: index,
      })),
    };
  }

  async function submit() {
    setSaved(null);
    const input = build();

    /*
     * Every problem at once, from the SAME function the action validates with.
     * Revealing them one save at a time is how a person edits a twenty-step list
     * five times to find out about three mistakes — and a second copy of the
     * rules here is how the editor comes to accept something the server refuses.
     */
    const found = [...templateProblems(input)];
    if (!input.name) found.unshift("Give this list a name.");
    if (input.items.some((item) => !item.label)) found.unshift("Every step needs a label.");
    if (found.length > 0) {
      setProblems(found);
      return;
    }

    setProblems([]);
    setBusy(true);
    const result = await save(template.id ?? null, input);
    setBusy(false);
    if (result.error) {
      setProblems([result.error]);
      return;
    }
    setSaved(result.success ?? "Saved.");
  }

  /**
   * Delete, with the refusal shown.
   *
   * The action refuses a list that already has runs against it and says so —
   * deleting one would take completed evidence with it, and deactivating is
   * almost always what was meant. Firing this and ignoring the result would show
   * a button that appears to do nothing.
   */
  async function discard() {
    if (!template.id || !remove) return;
    setBusy(true);
    const result = await remove(template.id);
    setBusy(false);
    if (result.error) setProblems([result.error]);
  }

  const dragged = activeKey ? items.find((item) => item.key === activeKey) : undefined;
  const rows = layoutWithMarker(keys, activeKey, preview);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`name-${template.id ?? "new"}`}>
            List name
          </label>
          <input
            id={`name-${template.id ?? "new"}`}
            className="input"
            value={name}
            maxLength={CHECKLIST_LIMITS.labelLength}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(null);
            }}
            placeholder="e.g. Delivery handover"
          />
        </div>

        <div>
          <label className="label" htmlFor={`host-${template.id ?? "new"}`}>
            This list is for
          </label>
          <select
            id={`host-${template.id ?? "new"}`}
            className="input"
            value={host}
            onChange={(event) => {
              setHost(event.target.value as HostId);
              setSaved(null);
            }}
          >
            {hosts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {hosts.find((option) => option.id === host)?.description}
          </p>
        </div>

        <div>
          <label className="label" htmlFor={`description-${template.id ?? "new"}`}>
            Description
          </label>
          <input
            id={`description-${template.id ?? "new"}`}
            className="input"
            value={description}
            maxLength={CHECKLIST_LIMITS.descriptionLength}
            onChange={(event) => {
              setDescription(event.target.value);
              setSaved(null);
            }}
            placeholder="When this list should be used"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2">
          <input
            type="checkbox"
            className="size-4"
            checked={active}
            onChange={(event) => {
              setActive(event.target.checked);
              setSaved(null);
            }}
          />
          {/* Inactive rather than deleted: a list nobody may start any more, but
              whose completed runs still read correctly. */}
          Active — offered when somebody starts a checklist on this record
        </label>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Steps ({items.length} of {CHECKLIST_LIMITS.itemsPerTemplate})
          </h3>
          <button
            type="button"
            onClick={addItem}
            disabled={items.length >= CHECKLIST_LIMITS.itemsPerTemplate}
            className="btn-secondary btn-sm"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add a step
          </button>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          measuring={MEASURE_ALWAYS}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={endDrag}
        >
          <SortableContext items={sortableItems} strategy={NO_TRANSFORM}>
            <ItemList
              rows={rows}
              items={items}
              activeHeight={activeHeight}
              onPatch={patch}
              onRemove={dropItem}
            />
          </SortableContext>

          {overlayHost
            ? createPortal(
                <DragOverlay
                  dropAnimation={null}
                  modifiers={[snapToCursor]}
                  style={{ width: "auto", height: "auto" }}
                >
                  {dragged ? (
                    <div className="flex cursor-grabbing items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 text-xs font-medium text-foreground shadow-lg">
                      <GripVertical className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      {dragged.label || "Untitled step"}
                    </div>
                  ) : null}
                </DragOverlay>,
                overlayHost,
              )
            : null}
        </DndContext>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-3" role="alert">
          {problems.map((message) => (
            <li key={message} className="text-xs text-red-200">
              {message}
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3">
        {template.id && remove ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void discard()}
            className="btn-danger btn-sm"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Delete list
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {saved}
            </span>
          )}
          <button type="button" disabled={busy} onClick={() => void submit()} className="btn-primary btn-sm">
            {busy ? "Saving…" : template.id ? "Save changes" : "Create list"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── the list ─────────────────────────────────────────────────────────── */

type Row = { kind: "item"; key: string } | { kind: "marker" };

/**
 * The rows, with a marker where the dragged one would land.
 *
 * ONE ROW LEAVES, ONE ROW ARRIVES. The dragged row is taken out of the flow and
 * the marker takes its place, so the number of rows — and, because the marker is
 * given the dragged row's measured height, the total height — is unchanged for
 * the whole gesture. An EXTRA marker row would push everything below it, which
 * re-measures them, which picks a different target, which moves the marker: you
 * end up aiming at something that moves because you aimed at it.
 */
export function layoutWithMarker(
  keys: readonly string[],
  activeKey: string | null,
  index: number | null,
): Row[] {
  const others = keys.filter((key) => key !== activeKey);
  const rows: Row[] = others.map((key) => ({ kind: "item", key }));
  if (activeKey === null || index === null) {
    return keys.map((key) => ({ kind: "item", key }));
  }
  const at = Math.max(0, Math.min(index, rows.length));
  return [...rows.slice(0, at), { kind: "marker" }, ...rows.slice(at)];
}

function ItemList({
  rows,
  items,
  activeHeight,
  onPatch,
  onRemove,
}: {
  rows: Row[];
  items: EditorItem[];
  activeHeight: number | null;
  onPatch: (key: string, change: Partial<EditorItem>) => void;
  onRemove: (key: string) => void;
}) {
  /*
   * The list is a drop target in its own right, and it has to be a real one —
   * declaring its id in the SortableContext is not enough. SortableContext only
   * says which items SORT; a droppable exists where useDroppable is called. Left
   * out, the empty space below the last row collides with nothing, an emptied
   * list can never be refilled, and every "the pointer is over the list" branch
   * is unreachable code.
   */
  const { setNodeRef } = useDroppable({ id: LIST_ID });
  const byKey = new Map(items.map((item) => [item.key, item]));

  return (
    <div ref={setNodeRef} className="space-y-2 rounded-xl border border-dashed border-border p-2">
      {rows.length === 0 && (
        <p className="p-4 text-center text-xs text-muted-foreground">
          No steps yet. A list with no steps is never offered.
        </p>
      )}
      {rows.map((row, index) =>
        row.kind === "marker" ? (
          <div
            key="drop-marker"
            aria-hidden="true"
            style={activeHeight ? { minHeight: activeHeight } : undefined}
            className="flex min-h-14 items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10"
          >
            <span className="rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground">
              Drops here
            </span>
          </div>
        ) : (
          <ItemRow
            key={row.key}
            position={index + 1}
            item={byKey.get(row.key)!}
            onPatch={onPatch}
            onRemove={onRemove}
          />
        ),
      )}
    </div>
  );
}

function ItemRow({
  position,
  item,
  onPatch,
  onRemove,
}: {
  position: number;
  item: EditorItem;
  onPatch: (key: string, change: Partial<EditorItem>) => void;
  onRemove: (key: string) => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useSortable({
    id: item.key,
    /*
     * NO LAYOUT ANIMATION, and it is a SEPARATE mechanism from the strategy
     * above. Left on, useSortable measures the row on every index change,
     * computes a FLIP delta and calls setState from a layout effect, with a
     * second effect that immediately sets it back — two renders per index
     * change, from the commit phase. Enough of those nested in one commit is
     * "Maximum update depth exceeded", thrown during commit, which the route's
     * error boundary turns into an error page. Nothing is lost: this component
     * applies no transform, so the value it computes is never read.
     */
    animateLayoutChanges: () => false,
  });
  const photos = isPhotoCapture(item.capture);
  const id = (field: string) => `${field}-${item.key}`;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-lg border border-border bg-card p-2.5",
        // Out of the flow while it is carried, so the marker can take its place
        // and the row count stays the same. `hidden` rather than unmounting:
        // this element holds useSortable's ref, and pulling it out mid-drag
        // takes the drag's own node with it.
        isDragging && "hidden",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Reorder step ${position}${item.label ? `, ${item.label}` : ""}`}
          className="mt-1 flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden="true" />
        </button>

        <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor={id("label")}>
              Step {position} — label
            </label>
            <input
              id={id("label")}
              className="input"
              value={item.label}
              maxLength={CHECKLIST_LIMITS.labelLength}
              onChange={(event) => onPatch(item.key, { label: event.target.value })}
              placeholder="e.g. Serial number"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="label" htmlFor={id("description")}>
              Guidance shown above the camera
            </label>
            <input
              id={id("description")}
              className="input"
              value={item.description}
              maxLength={CHECKLIST_LIMITS.descriptionLength}
              onChange={(event) => onPatch(item.key, { description: event.target.value })}
              placeholder="e.g. the plate on the frame under the seat, not the box"
            />
          </div>

          <div>
            <label className="label" htmlFor={id("capture")}>
              Collects
            </label>
            <select
              id={id("capture")}
              className="input"
              value={item.capture}
              onChange={(event) => {
                const capture = event.target.value as CaptureKind;
                /*
                 * A step that does not collect photos cannot require any — the
                 * capture screen would show a camera whose answer is never read,
                 * and `templateProblems` refuses the save. Corrected as the kind
                 * changes rather than reported afterwards.
                 */
                onPatch(item.key,
                  isPhotoCapture(capture)
                    ? { capture, minPhotos: Math.max(1, item.minPhotos), maxPhotos: Math.max(1, item.maxPhotos) }
                    : { capture, minPhotos: 0, maxPhotos: 1 },
                );
              }}
            >
              {CAPTURE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {CAPTURE_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-2">
            {photos && (
              <>
                <div className="min-w-0 flex-1">
                  <label className="label" htmlFor={id("min")}>
                    At least
                  </label>
                  <input
                    id={id("min")}
                    type="number"
                    className="input"
                    min={0}
                    max={CHECKLIST_LIMITS.photosPerItem}
                    value={item.minPhotos}
                    onChange={(event) =>
                      onPatch(item.key, { minPhotos: clamp(event.target.value, 0) })
                    }
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <label className="label" htmlFor={id("max")}>
                    At most
                  </label>
                  <input
                    id={id("max")}
                    type="number"
                    className="input"
                    min={1}
                    max={CHECKLIST_LIMITS.photosPerItem}
                    value={item.maxPhotos}
                    onChange={(event) =>
                      onPatch(item.key, { maxPhotos: clamp(event.target.value, 1) })
                    }
                  />
                </div>
              </>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4"
              checked={item.required}
              onChange={(event) => onPatch(item.key, { required: event.target.checked })}
            />
            Required — skipping it demands a reason
          </label>
        </div>

        <button
          type="button"
          onClick={() => onRemove(item.key)}
          aria-label={`Remove step ${position}${item.label ? `, ${item.label}` : ""}`}
          className="mt-1 flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** A number input can be emptied, and NaN in the payload fails the schema. */
function clamp(raw: string, floor: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return floor;
  return Math.max(floor, Math.min(CHECKLIST_LIMITS.photosPerItem, value));
}
