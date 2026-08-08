"use client";

import { useId, useMemo } from "react";
import { Plus, X } from "lucide-react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  LIMITS,
  cardProblems,
  isQueryCard,
  normaliseHref,
  type ButtonCard,
  type CardConfig,
  type CardMetric,
  type CardQuery,
  type CardType,
  type ChartCard,
  type GaugeCard,
  type GridCardConfig,
  type ListCard,
  type MarkdownCard,
  type QueryFilter,
  type StackCardConfig,
  type StatCard,
} from "@/lib/dashboard/config";
import {
  PERIODS,
  operatorsFor,
  sourceById,
  usableFields,
  usableSources,
  type SourceDef,
  type SourceField,
} from "@/lib/dashboard/sources";
import ConditionEditor from "./ConditionEditor";
import { useEditor } from "./EditorProvider";
import type { EditorAccess } from "./CardPicker";

/**
 * The dialog that configures ONE card, dispatched on `card.type` — CardPicker's
 * sibling: that dialog decides WHAT gets added, this one decides what it does.
 *
 * ── EVERY EDIT IS ITS OWN COMMIT ─────────────────────────────────────────────
 *
 * There is no local draft state and no Save button. `patch` below calls
 * `useEditor().updateCard` on every keystroke, and EditorProvider already
 * validates (`parseConfigStrict`) and coalesces the actual writes — see its own
 * header comment. Keeping a draft here and reconciling it on close would be a
 * second copy of the card that can disagree with the one on screen, which is
 * exactly the class of bug DashboardEditorProvider was written to make
 * impossible in the first place.
 *
 * ── WHAT "VALIDATE LIVE" MEANS HERE ──────────────────────────────────────────
 *
 * `cardProblems` runs once per render, straight off the `card` prop, and its
 * ONE message (it names the first problem it finds, not every problem) is shown
 * near whichever control most plausibly caused it — see `problemNear`. It is a
 * best guess: the message shape `"<name>" is not a field of <source>` is
 * identical whether it came from a filter, a sort, a column or a metric field,
 * and `cardProblems` does not say which. Nothing here invents a more confident
 * answer than that; the raw message is always shown verbatim, and
 * EditorProvider's own `parseConfigStrict` is the actual gate — this is early
 * warning, not enforcement.
 */
export default function CardBuilder({
  card,
  open,
  onOpenChange,
  access,
}: {
  card: CardConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  access: EditorAccess;
}) {
  const { updateCard } = useEditor();

  const accessKey = `${access.permissions.join(",")}|${access.modules.join(",")}`;
  const sets = useMemo(
    () => ({ permissions: new Set(access.permissions), modules: new Set(access.modules) }),
    // access is folded into accessKey by value — same trick CardPicker uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessKey],
  );

  /**
   * The one way anything in this dialog changes the card. A plain closure, not
   * a hook, so it is perfectly safe to call from inside a branch that has
   * already narrowed `card` to one specific variant (`card.type === "stat"`
   * narrows `card` for TypeScript too) — the generic `T` is inferred from
   * whichever caller passed it in, which is what stops a gauge-only field from
   * ever being able to patch a list card by accident.
   */
  function patch<T extends CardConfig>(current: T, change: Partial<T>): void {
    updateCard(current.id, (latest) => ({ ...(latest as T), ...change }));
  }

  if (!card) {
    // Nothing selected. The Dialog stays mounted, closed, rather than this
    // whole component unmounting around it — hook order above must never
    // depend on whether a card happens to be chosen this render.
    return <Dialog open={false} onOpenChange={onOpenChange} />;
  }

  const problem = isQueryCard(card.type) ? cardProblems(card) : null;
  const availableSignals = CARD_SIGNALS[card.type] ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{card.title?.trim() || TYPE_LABEL[card.type]}</DialogTitle>
          <DialogDescription>Customise this card.</DialogDescription>
        </DialogHeader>

        <ScrollArea className="-mx-1 max-h-[65vh] px-1">
          <div className="space-y-5 pb-1">
            <CommonFields card={card} patch={patch} />

            {card.type === "stat" && (
              <StatFields card={card} patch={patch} sets={sets} problem={problem} />
            )}
            {card.type === "list" && (
              <ListFields card={card} patch={patch} sets={sets} problem={problem} />
            )}
            {card.type === "chart" && (
              <ChartFields card={card} patch={patch} sets={sets} problem={problem} />
            )}
            {card.type === "gauge" && (
              <GaugeFields card={card} patch={patch} sets={sets} problem={problem} />
            )}
            {card.type === "markdown" && <MarkdownFields card={card} patch={patch} />}
            {card.type === "button" && <ButtonFields card={card} patch={patch} />}
            {card.type === "grid" && <GridFields card={card} patch={patch} />}
            {card.type === "stack" && <StackFields card={card} patch={patch} />}
            {/* "heading" and "builtin" have nothing beyond the common fields above:
                a heading is title + span, and a builtin card's own settings live
                in its source page, not here. */}

            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Visibility
              </h3>
              <ConditionEditor
                value={card.visibility}
                onChange={(next) => patch(card, { visibility: next })}
                availableSignals={availableSignals}
                access={access}
              />
            </section>
          </div>
        </ScrollArea>
      </ResponsiveDialogContent>
    </Dialog>
  );
}

type Patch = <T extends CardConfig>(current: T, change: Partial<T>) => void;
type EditorAccessSets = { permissions: ReadonlySet<string>; modules: ReadonlySet<string> };

/* ── common to every card ─────────────────────────────────────────── */

const SPAN_OPTIONS = [1, 2, 3, 4] as const;

function CommonFields({ card, patch }: { card: CardConfig; patch: Patch }) {
  const titleId = useId();

  return (
    <section className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          value={card.title ?? ""}
          maxLength={LIMITS.titleLength}
          onChange={(e) => patch(card, { title: e.target.value || undefined })}
          placeholder={TYPE_LABEL[card.type]}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Width</Label>
        {/*
          Tailwind classes as STATIC strings via CHIP_ACTIVE/CHIP_INACTIVE below
          — never `col-span-${n}` — same discipline CardPicker's WIDTH/TONE
          tables and cards/shell.tsx's SPAN_IN_GRID spell out at length: Tailwind
          scans source TEXT, so a computed class name is never generated into the
          stylesheet and the control would silently stop reflecting state.
        */}
        <div className="flex gap-1.5">
          {SPAN_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={card.span === n}
              aria-label={`Span ${n} column${n > 1 ? "s" : ""}`}
              onClick={() => patch(card, { span: n })}
              className={cn(CHIP_BASE, "w-8 justify-center", card.span === n ? CHIP_ACTIVE : CHIP_INACTIVE)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <DisabledToggle card={card} patch={patch} />
    </section>
  );
}

function DisabledToggle({ card, patch }: { card: CardConfig; patch: Patch }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2">
      <div>
        <Label htmlFor={id}>Disabled</Label>
        <p className="text-[11px] text-muted-foreground">
          Kept on the dashboard but hidden — the quick way to try without it rather than delete
          and rebuild it later.
        </p>
      </div>
      <Switch id={id} checked={card.disabled ?? false} onCheckedChange={(disabled) => patch(card, { disabled })} />
    </div>
  );
}

/* ── query cards: source, filters, scope, period, sort, limit ────────── */

function QueryFields({
  query,
  onQueryChange,
  sets,
  problem,
}: {
  query: CardQuery;
  onQueryChange: (change: Partial<CardQuery>) => void;
  sets: EditorAccessSets;
  problem: string | null;
}) {
  const sourceId = useId();
  const scopeId = useId();
  const periodId = useId();
  const limitId = useId();

  const sources = useMemo(() => usableSources(sets), [sets]);
  const source = sourceById(query.source);
  const fields = source ? usableFields(source, sets) : [];
  // Do not offer `scope: "mine"` for a source with no `type: "user"` field — it
  // would compile to a predicate matching no owner column at all, i.e. "match
  // nothing", which is worse than never having offered the switch.
  const hasOwner = source ? source.fields.some((f) => f.type === "user") : false;

  return (
    <section className="space-y-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Data</h3>

      <div className="space-y-1.5">
        <Label htmlFor={sourceId}>Source</Label>
        <Select
          value={query.source}
          onValueChange={(value) =>
            // Filters and the sort name fields of the OLD source, so a source
            // change starts them clean rather than leaving a filter cardProblems
            // will flag a moment later.
            onQueryChange({ source: value as CardQuery["source"], filters: [], sort: undefined })
          }
        >
          <SelectTrigger id={sourceId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {mentions(problem, "Unknown data source") && <ProblemText>{problem}</ProblemText>}
      </div>

      <FilterList fields={fields} filters={query.filters} onChange={(filters) => onQueryChange({ filters })} />
      {problem && !mentions(problem, "sort", "group", "total") && <ProblemText>{problem}</ProblemText>}

      {hasOwner && (
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label htmlFor={scopeId}>Just mine</Label>
            <p className="text-[11px] text-muted-foreground">
              Narrows to rows assigned to you. This only ever narrows — everyone still sees no more
              than their own row scope already allows.
            </p>
          </div>
          <Switch
            id={scopeId}
            checked={query.scope === "mine"}
            onCheckedChange={(checked) => onQueryChange({ scope: checked ? "mine" : "team" })}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={periodId}>Time window</Label>
        <Select value={query.period} onValueChange={(value) => onQueryChange({ period: value as CardQuery["period"] })}>
          <SelectTrigger id={periodId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SortPicker fields={fields} sort={query.sort} onChange={(sort) => onQueryChange({ sort })} />
      {mentions(problem, "sort") && <ProblemText>{problem}</ProblemText>}

      <div className="space-y-1.5">
        <Label htmlFor={limitId}>Row limit</Label>
        <Input
          id={limitId}
          type="number"
          min={1}
          max={LIMITS.listRows}
          value={query.limit}
          onChange={(e) => onQueryChange({ limit: clamp(Number(e.target.value) || 1, 1, LIMITS.listRows) })}
          className="w-24"
        />
      </div>
    </section>
  );
}

function FilterList({
  fields,
  filters,
  onChange,
}: {
  fields: SourceField[];
  filters: QueryFilter[];
  onChange: (next: QueryFilter[]) => void;
}) {
  const filterable = fields.filter((f) => f.filterable !== false);

  function update(index: number, next: QueryFilter) {
    onChange(filters.map((f, i) => (i === index ? next : f)));
  }
  function remove(index: number) {
    onChange(filters.filter((_, i) => i !== index));
  }
  function add() {
    const field = filterable[0];
    if (!field) return;
    onChange([...filters, { field: field.key, operator: operatorsFor(field)[0] as QueryFilter["operator"], value: undefined }]);
  }

  return (
    <div className="space-y-1.5">
      <Label>Filters</Label>
      {filters.map((filter, index) => (
        // Index as key: a filter carries no id of its own and order is stable
        // across edits — same reasoning ConditionEditor's ConditionList gives.
        <FilterRow key={index} filter={filter} fields={filterable} onChange={(next) => update(index, next)} onRemove={() => remove(index)} />
      ))}
      {filters.length < LIMITS.filtersPerCard && filterable.length > 0 && (
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={add}>
          <Plus className="size-3.5" />
          Add a filter
        </Button>
      )}
    </div>
  );
}

function FilterRow({
  filter,
  fields,
  onChange,
  onRemove,
}: {
  filter: QueryFilter;
  fields: SourceField[];
  onChange: (next: QueryFilter) => void;
  onRemove: () => void;
}) {
  const field = fields.find((f) => f.key === filter.field) ?? fields[0];
  const ops = field ? operatorsFor(field) : [];
  const needsValue = filter.operator !== "is_empty" && filter.operator !== "is_not_empty";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={field?.key}
        onValueChange={(key) => {
          const next = fields.find((f) => f.key === key);
          if (!next) return;
          onChange({ field: key, operator: operatorsFor(next)[0] as QueryFilter["operator"], value: undefined });
        }}
      >
        <SelectTrigger size="sm" className="h-8 text-xs" aria-label="Field to filter on">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filter.operator}
        onValueChange={(operator) => onChange({ ...filter, operator: operator as QueryFilter["operator"], value: undefined })}
      >
        <SelectTrigger size="sm" className="h-8 text-xs" aria-label="Comparison">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABEL[op] ?? op}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsValue && field && (
        <FilterValueInput field={field} operator={filter.operator} value={filter.value} onChange={(value) => onChange({ ...filter, value })} />
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove this filter"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function FilterValueInput({
  field,
  operator,
  value,
  onChange,
}: {
  field: SourceField;
  operator: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (operator === "in") {
    if (field.type === "enum" && field.options) {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1">
          {field.options.map((opt) => {
            const active = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => onChange(active ? selected.filter((v) => v !== opt.value) : [...selected, opt.value])}
                className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <Input
        aria-label={`${field.label}, comma-separated`}
        value={Array.isArray(value) ? (value as string[]).join(", ") : ""}
        onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
        placeholder="comma-separated"
        className="h-8 w-40 text-xs"
      />
    );
  }

  switch (field.type) {
    case "number":
      return (
        <Input
          aria-label={field.label}
          type="number"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className="h-8 w-28 text-xs"
        />
      );
    case "money":
      return (
        <Input
          // RANDS IN, CENTS OUT — see lib/dashboard/compile.ts's coerceValue,
          // the ONE place a money value is multiplied by 100. This box collects
          // exactly what a person types, in rands.
          aria-label={`${field.label} (rands)`}
          type="number"
          step="0.01"
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          placeholder="rands"
          className="h-8 w-28 text-xs"
        />
      );
    case "date":
      return (
        <Input
          aria-label={field.label}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-8 w-36 text-xs"
        />
      );
    case "boolean":
      return (
        <Select value={value === true ? "true" : value === false ? "false" : undefined} onValueChange={(v) => onChange(v === "true")}>
          <SelectTrigger size="sm" className="h-8 text-xs" aria-label={field.label}>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      );
    case "enum":
      return (
        <Select value={typeof value === "string" ? value : undefined} onValueChange={onChange}>
          <SelectTrigger size="sm" className="h-8 text-xs" aria-label={field.label}>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "user":
      // No catalogue of people is reachable from here — see ConditionEditor's
      // header note on the same limit for `user` conditions, and CardPicker's
      // own note on why lib/permissions cannot be imported by a client
      // component. The id is typed by hand; a wrong one just matches no row.
      return (
        <Input
          aria-label={`${field.label} (user id)`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="user id"
          className="h-8 w-36 text-xs"
        />
      );
    default:
      return (
        <Input
          aria-label={field.label}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-36 text-xs"
        />
      );
  }
}

function SortPicker({
  fields,
  sort,
  onChange,
}: {
  fields: SourceField[];
  sort: CardQuery["sort"];
  onChange: (next: CardQuery["sort"]) => void;
}) {
  const fieldId = useId();
  const sortable = fields.filter((f) => f.sortable !== false);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>Sort by</Label>
      <div className="flex items-center gap-1.5">
        <Select
          value={sort?.field ?? DEFAULT_SORT_VALUE}
          onValueChange={(key) => onChange(key === DEFAULT_SORT_VALUE ? undefined : { field: key, dir: sort?.dir ?? "desc" })}
        >
          <SelectTrigger id={fieldId} size="sm" className="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_SORT_VALUE}>Source default</SelectItem>
            {sortable.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {sort && (
          <Select value={sort.dir} onValueChange={(dir) => onChange({ field: sort.field, dir: dir as "asc" | "desc" })}>
            <SelectTrigger size="sm" className="h-8 w-36 text-xs" aria-label="Sort direction">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest / highest first</SelectItem>
              <SelectItem value="asc">Oldest / lowest first</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

/* ── metric: fn + field, shared by stat / chart / gauge ───────────── */

function MetricPicker({
  source,
  sets,
  metric,
  onChange,
}: {
  source: SourceDef | undefined;
  sets: EditorAccessSets;
  metric: CardMetric;
  onChange: (next: CardMetric) => void;
}) {
  const fnId = useId();
  const fields = source ? usableFields(source, sets).filter((f) => f.aggregatable === true) : [];

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fnId}>What to show</Label>
      <div className="flex items-center gap-1.5">
        <Select
          value={metric.fn}
          onValueChange={(fn) => onChange({ fn: fn as CardMetric["fn"], field: fn === "count" ? undefined : metric.field })}
        >
          <SelectTrigger id={fnId} size="sm" className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="count">Count</SelectItem>
            <SelectItem value="sum">Total</SelectItem>
            <SelectItem value="avg">Average</SelectItem>
            <SelectItem value="min">Lowest</SelectItem>
            <SelectItem value="max">Highest</SelectItem>
          </SelectContent>
        </Select>
        {metric.fn !== "count" && (
          <Select value={metric.field} onValueChange={(field) => onChange({ ...metric, field })}>
            <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label="Field to total">
              <SelectValue placeholder="Choose a field" />
            </SelectTrigger>
            <SelectContent>
              {fields.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

/* ── per-type fields ──────────────────────────────────────────────── */

function StatFields({
  card,
  patch,
  sets,
  problem,
}: {
  card: StatCard;
  patch: Patch;
  sets: EditorAccessSets;
  problem: string | null;
}) {
  const source = sourceById(card.query.source);
  const compareId = useId();
  const hrefId = useId();

  return (
    <>
      <QueryFields query={card.query} onQueryChange={(change) => patch(card, { query: { ...card.query, ...change } })} sets={sets} problem={problem} />
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Number</h3>
        <MetricPicker source={source} sets={sets} metric={card.metric} onChange={(metric) => patch(card, { metric })} />
        {mentions(problem, "total") && <ProblemText>{problem}</ProblemText>}
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={compareId}>Compare to the period before</Label>
          <Switch id={compareId} checked={card.compare} onCheckedChange={(compare) => patch(card, { compare })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={hrefId}>Link (optional)</Label>
          {/* A phishing guard, same reasoning as ButtonFields below: an href a
              stat tile links to is exactly as capable of leaving the app as a
              shortcut tile's, and normaliseHref is the one function that
              decides what "inside the app" means. */}
          <Input id={hrefId} value={card.href ?? ""} onChange={(e) => patch(card, { href: e.target.value || undefined })} placeholder="/leads" />
          {card.href && normaliseHref(card.href) === null && (
            <ProblemText>Must be a path inside the app, starting with a single &quot;/&quot;.</ProblemText>
          )}
        </div>
      </section>
    </>
  );
}

function ListFields({
  card,
  patch,
  sets,
  problem,
}: {
  card: ListCard;
  patch: Patch;
  sets: EditorAccessSets;
  problem: string | null;
}) {
  const source = sourceById(card.query.source);
  const fields = source ? usableFields(source, sets) : [];

  return (
    <>
      <QueryFields query={card.query} onQueryChange={(change) => patch(card, { query: { ...card.query, ...change } })} sets={sets} problem={problem} />
      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Columns</h3>
        <p className="text-[11px] text-muted-foreground">Up to {LIMITS.columnsPerCard}, in the order ticked.</p>
        <div className="space-y-1">
          {fields.map((field) => {
            const checked = card.columns.includes(field.key);
            const atLimit = card.columns.length >= LIMITS.columnsPerCard;
            return (
              <label key={field.key} className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && atLimit}
                  onChange={() =>
                    patch(card, {
                      columns: checked ? card.columns.filter((k) => k !== field.key) : [...card.columns, field.key],
                    })
                  }
                  className="size-3.5 rounded border-input"
                />
                {field.label}
              </label>
            );
          })}
        </div>
      </section>
    </>
  );
}

function ChartFields({
  card,
  patch,
  sets,
  problem,
}: {
  card: ChartCard;
  patch: Patch;
  sets: EditorAccessSets;
  problem: string | null;
}) {
  const source = sourceById(card.query.source);
  const groupById = useId();
  // Mirrors CardPicker's firstGroupableKey rule exactly: groupable must be
  // TRUE, and a composite (`.paths`) is display-only, so it cannot be grouped
  // by even though it can be selected.
  const groupable = source ? usableFields(source, sets).filter((f) => f.groupable === true && !f.paths) : [];

  return (
    <>
      <QueryFields query={card.query} onQueryChange={(change) => patch(card, { query: { ...card.query, ...change } })} sets={sets} problem={problem} />
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Chart</h3>
        <div className="space-y-1.5">
          <Label htmlFor={groupById}>Group by</Label>
          <Select value={card.groupBy} onValueChange={(groupBy) => patch(card, { groupBy })}>
            <SelectTrigger id={groupById} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groupable.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mentions(problem, "group") && <ProblemText>{problem}</ProblemText>}
        </div>
        <MetricPicker source={source} sets={sets} metric={card.metric} onChange={(metric) => patch(card, { metric })} />
        {mentions(problem, "total") && <ProblemText>{problem}</ProblemText>}
        <div className="space-y-1.5">
          <Label>Shape</Label>
          <div className="flex gap-1.5">
            {(["bar", "donut"] as const).map((style) => (
              <button
                key={style}
                type="button"
                aria-pressed={card.style === style}
                onClick={() => patch(card, { style })}
                className={cn(CHIP_BASE, card.style === style ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                {style === "bar" ? "Bars" : "Doughnut"}
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function GaugeFields({
  card,
  patch,
  sets,
  problem,
}: {
  card: GaugeCard;
  patch: Patch;
  sets: EditorAccessSets;
  problem: string | null;
}) {
  const source = sourceById(card.query.source);
  const fields = source ? usableFields(source, sets) : [];
  const metricField = card.metric.fn !== "count" ? fields.find((f) => f.key === card.metric.field) : null;
  const asMoney = metricField?.type === "money";
  const targetId = useId();
  const unitId = useId();

  return (
    <>
      <QueryFields query={card.query} onQueryChange={(change) => patch(card, { query: { ...card.query, ...change } })} sets={sets} problem={problem} />
      <section className="space-y-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Progress ring</h3>
        <MetricPicker source={source} sets={sets} metric={card.metric} onChange={(metric) => patch(card, { metric })} />
        {mentions(problem, "total") && <ProblemText>{problem}</ProblemText>}
        <div className="space-y-1.5">
          <Label htmlFor={targetId}>{asMoney ? "Target (rands)" : "Target"}</Label>
          {/*
            THE TARGET IS COLLECTED IN RANDS, ALWAYS — see the block comment at
            the top of components/dashboard/cards/gauge.tsx ("THE TARGET IS
            STORED IN RANDS AND COMPARED IN CENTS"). That renderer multiplies by
            100 exactly once, on the way into a cents comparison against the
            aggregate it queried, and says outright that the editor's job is to
            collect rands and never pre-multiply. Typing 50000 here means
            R50 000 — the same convention as a money filter's value above, one
            place it turns into cents, and this is not that place.
          */}
          <Input
            id={targetId}
            type="number"
            min={1}
            value={card.target}
            onChange={(e) => patch(card, { target: Math.max(1, Number(e.target.value) || 1) })}
            className="w-32"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={unitId}>Unit (optional)</Label>
          <Input
            id={unitId}
            value={card.unit ?? ""}
            maxLength={12}
            onChange={(e) => patch(card, { unit: e.target.value || undefined })}
            placeholder="e.g. jobs"
            className="w-32"
          />
        </div>
      </section>
    </>
  );
}

function MarkdownFields({ card, patch }: { card: MarkdownCard; patch: Patch }) {
  const id = useId();
  return (
    <section className="space-y-1.5">
      <Label htmlFor={id}>Note</Label>
      {/*
        A plain <textarea>, not a rich editor: there is no markdown dependency
        and no sanitising renderer anywhere in this feature (see the CONTENT
        field's own comment in lib/dashboard/config.ts) — plain text in is what
        keeps plain text out the other end.
      */}
      <textarea
        id={id}
        value={card.content}
        maxLength={LIMITS.markdownLength}
        rows={6}
        onChange={(e) => patch(card, { content: e.target.value })}
        className="w-full min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <p className="text-right text-[11px] text-muted-foreground">
        {card.content.length} / {LIMITS.markdownLength}
      </p>
    </section>
  );
}

function ButtonFields({ card, patch }: { card: ButtonCard; patch: Patch }) {
  const id = useId();
  const invalid = card.href.length > 0 && normaliseHref(card.href) === null;

  return (
    <section className="space-y-1.5">
      <Label htmlFor={id}>Opens</Label>
      {/*
        A PHISHING GUARD, not a formatting rule. A dashboard is screenshotted
        and shared by shoulder; a shortcut tile that could be pointed off-site
        would put a link to anywhere behind the same chrome as every genuine
        internal button. `normaliseHref` (lib/dashboard/config.ts) is the one
        function that decides what "inside the app" means — this just says so
        before the click that saves it, rather than only at render time.
      */}
      <Input id={id} value={card.href} onChange={(e) => patch(card, { href: e.target.value })} placeholder="/leads" />
      {invalid && <ProblemText>Must be a path inside the app, starting with a single &quot;/&quot;.</ProblemText>}
    </section>
  );
}

function GridFields({ card, patch }: { card: GridCardConfig; patch: Patch }) {
  return (
    <section className="space-y-1.5">
      <Label>Columns</Label>
      <div className="flex gap-1.5">
        {([2, 3, 4] as const).map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={card.columns === n}
            aria-label={`${n} columns`}
            onClick={() => patch(card, { columns: n })}
            className={cn(CHIP_BASE, "w-8 justify-center", card.columns === n ? CHIP_ACTIVE : CHIP_INACTIVE)}
          >
            {n}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The cards inside are arranged on the canvas, not here — this only edits the grid&apos;s own
        settings.
      </p>
    </section>
  );
}

function StackFields({ card, patch }: { card: StackCardConfig; patch: Patch }) {
  return (
    <section className="space-y-1.5">
      <Label>Direction</Label>
      <div className="flex gap-1.5">
        {(["vertical", "horizontal"] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={card.direction === d}
            onClick={() => patch(card, { direction: d })}
            className={cn(CHIP_BASE, card.direction === d ? CHIP_ACTIVE : CHIP_INACTIVE)}
          >
            {d === "vertical" ? "Down the page" : "Across"}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The cards inside are arranged on the canvas, not here — this only edits the stack&apos;s own
        settings.
      </p>
    </section>
  );
}

/* ── small shared pieces ──────────────────────────────────────────── */

function ProblemText({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-destructive">{children}</p>;
}

/** cardProblems returns ONE message for the whole card — this is the closest a single string can get to "near the right control", not a certainty. */
function mentions(problem: string | null, ...keywords: string[]): boolean {
  if (!problem) return false;
  return keywords.some((k) => problem.toLowerCase().includes(k.toLowerCase()));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

const DEFAULT_SORT_VALUE = "__default";

const TYPE_LABEL: Record<CardType, string> = {
  builtin: "Built-in card",
  stat: "Number",
  list: "List",
  chart: "Chart",
  gauge: "Progress ring",
  markdown: "Note",
  heading: "Heading",
  button: "Shortcut",
  grid: "Grid",
  stack: "Stack",
};

/**
 * Which `data` signal names a card of this type actually publishes — see the
 * SIGNAL VOCABULARY comment at the top of components/dashboard/cards/shell.tsx.
 * `grid` and `stack` publish `children` instead of the four card names (how
 * many of THEIR OWN children survived their own conditions — see
 * cards/container.tsx) since a container's own visibility is evaluated against
 * its own signals, same as any other card's. Types with no comment below run
 * no query and publish nothing.
 */
const CARD_SIGNALS: Record<CardType, string[]> = {
  builtin: [],
  stat: ["count", "total"],
  list: ["count", "shown"],
  chart: ["count", "total", "groups"],
  gauge: ["count", "total"],
  markdown: [],
  heading: [],
  button: [],
  grid: ["children"],
  stack: ["children"],
};

const OPERATOR_LABEL: Record<string, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  greater_than: "is more than",
  greater_or_equal: "is at least",
  less_than: "is less than",
  less_or_equal: "is at most",
  in: "is one of",
  is_empty: "is empty",
  is_not_empty: "has a value",
};

/*
 * Static class strings only, per this file's Tailwind discipline — every
 * toggle button below (span, filter chips, chart style, grid columns, stack
 * direction) switches between these two full strings rather than interpolating
 * one, for the reason CardPicker's own WIDTH/TONE tables give.
 */
const CHIP_BASE = "rounded-full border px-2.5 py-1 text-[11px] transition-colors";
const CHIP_ACTIVE = "border-primary/50 bg-primary/10 text-foreground";
const CHIP_INACTIVE = "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground";
