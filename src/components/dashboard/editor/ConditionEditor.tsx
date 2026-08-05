"use client";

import { useId, useState } from "react";
import { Plus, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  BREAKPOINTS,
  CONDITION_KINDS,
  MAX_CONDITIONS,
  MAX_CONDITION_DEPTH,
  isSecurityRelevant,
  type Condition,
  type ConditionKind,
  type ConditionOperator,
} from "@/lib/dashboard/conditions";
import { MODULE_REGISTRY, type ModuleId } from "@/lib/modules/registry";
import type { EditorAccess } from "./CardPicker";

/**
 * The condition builder — one list of rules, AND-ed at the top, with `and` /
 * `or` / `not` available as grouping up to MAX_CONDITION_DEPTH.
 *
 * ── THE RULE THIS WHOLE FILE IS BUILT AROUND ────────────────────────────────
 *
 * conditionSchema in lib/dashboard/config.ts requires at least ONE entry in
 * every array a condition carries — `users`, `roles`, `permissions`,
 * `modules`, `breakpoints`, `conditions` (a group's children) all have
 * `.min(1)`. EditorProvider validates on every call to `update`, which this
 * component reaches through CardBuilder, so the instant this list contains a
 * condition with an empty array, the WHOLE config fails to save — silently,
 * from here, because the click that caused it just watches its own edit get
 * reverted with a toast it never sees.
 *
 * So nothing below ever constructs one of those. A new `user` / `role` /
 * `permission` rule is not added until its first value exists (see
 * `ComposeTagInput`); a new group is seeded with one real child, never zero
 * (see `ConditionPicker`'s "nested" mode); and removing the last value from an
 * existing rule removes the whole rule rather than leaving an empty array
 * behind (see `ConditionList`'s `minItems` / `onDeplete`, and `TagListBody`).
 * Every one of those is the same bug wearing a different shape, which is why
 * it is written once, as a rule, rather than fixed four times.
 *
 * ── WHY user / role / permission ARE TYPED, NOT PICKED ──────────────────────
 *
 * `data`'s field list comes in as `availableSignals`. `module`'s catalogue is
 * `MODULE_REGISTRY`, a plain array with no server import, so it is used
 * directly. Neither exists for people, roles or permission keys: they are rows
 * in this tenant's database, not code, and the one file that lists every
 * permission key (`lib/permissions.ts`) pulls in Prisma and `next/navigation`
 * — CardPicker.tsx says exactly the same about the same file, for exactly the
 * same reason it cannot be imported here. So those three kinds take free text.
 * `access.permissions` — what the server already resolved for the person
 * editing THIS dashboard — is offered as quick-add suggestions on the
 * permission rule, because it costs nothing extra and, unlike a made-up
 * example, is guaranteed to be a real key. It is not exhaustive — the author
 * may need to name a permission they do not personally hold — so typing one in
 * always works too.
 */
export default function ConditionEditor({
  value,
  onChange,
  availableSignals,
  access,
}: {
  value: Condition[] | undefined;
  onChange: (next: Condition[] | undefined) => void;
  /** Which `data` field names this card actually publishes — see shell.tsx. Empty for section/view level. */
  availableSignals: string[];
  access: EditorAccess;
}) {
  const conditions = value ?? [];
  const hasScreenRule = conditions.some((c) => isSecurityRelevant(c));

  return (
    <div className="space-y-2">
      {/*
        NON-NEGOTIABLE. Always on screen, never a tooltip, never behind a
        click, whenever a `screen` condition exists ANYWHERE in this tree —
        see isSecurityRelevant, which already walks into `and` / `or` / `not`
        for exactly this reason.
      */}
      {hasScreenRule && <ScreenWarning />}

      {conditions.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
          <p className="text-xs text-muted-foreground">Always shown</p>
          <ConditionPicker
            depth={1}
            availableSignals={availableSignals}
            access={access}
            triggerLabel="Add a rule"
            onPick={(condition) => onChange([condition])}
          />
        </div>
      ) : (
        <ConditionList
          conditions={conditions}
          onChange={(next) => onChange(next.length > 0 ? next : undefined)}
          onDeplete={() => onChange(undefined)}
          minItems={0}
          depth={1}
          availableSignals={availableSignals}
          access={access}
        />
      )}
    </div>
  );
}

/* ── the warning ──────────────────────────────────────────────────── */

function ScreenWarning() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
      <p className="text-xs leading-snug text-amber-800 dark:text-amber-300">
        A screen-size rule only hides this card in the browser — the information behind it has
        already been sent there. It is a layout tool for tidying small screens, and it must never
        be relied on to keep something from someone who should not see it.
      </p>
    </div>
  );
}

/* ── a list of conditions, AND-ed, with its own "add a rule" ─────────── */

/**
 * One array of conditions — the top-level list, or one group's children —
 * rendered with a row per condition and an add control at the end.
 *
 * `minItems` is the one thing that differs between the two callers. The
 * top-level list has no floor (`value` may end up `[]`, which the caller above
 * turns into `undefined`); a group's `conditions` array has a floor of 1 by
 * schema, so removing its last child does not shrink the array to zero — it
 * calls `onDeplete`, which the caller wires to the GROUP's own removal,
 * dissolving a group that has nothing left in it rather than saving one that
 * schema would refuse.
 */
function ConditionList({
  conditions,
  onChange,
  onDeplete,
  minItems,
  depth,
  availableSignals,
  access,
}: {
  conditions: Condition[];
  onChange: (next: Condition[]) => void;
  onDeplete: () => void;
  minItems: 0 | 1;
  depth: number;
  availableSignals: string[];
  access: EditorAccess;
}) {
  function removeAt(index: number) {
    const next = conditions.filter((_, i) => i !== index);
    if (next.length < minItems) onDeplete();
    else onChange(next);
  }

  return (
    <div className="space-y-2">
      {conditions.map((condition, index) => (
        // Index as key: a Condition carries no id of its own — see the type
        // in lib/dashboard/conditions.ts — and inventing one here would mean
        // storing something the schema does not, and stripping it out again
        // on every change. Order is otherwise stable across edits, so this is
        // the honest key rather than a workaround.
        <ConditionRow
          key={index}
          condition={condition}
          onChange={(next) => onChange(conditions.map((c, i) => (i === index ? next : c)))}
          onRemove={() => removeAt(index)}
          depth={depth}
          availableSignals={availableSignals}
          access={access}
        />
      ))}
      {conditions.length < MAX_CONDITIONS && (
        <ConditionPicker
          depth={depth}
          availableSignals={availableSignals}
          access={access}
          triggerLabel={conditions.length === 0 ? "Add a rule" : "Add another rule"}
          onPick={(condition) => onChange([...conditions, condition])}
        />
      )}
    </div>
  );
}

/* ── one condition, dispatched by kind ────────────────────────────── */

function ConditionRow({
  condition,
  onChange,
  onRemove,
  depth,
  availableSignals,
  access,
}: {
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove: () => void;
  depth: number;
  availableSignals: string[];
  access: EditorAccess;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium text-foreground">{KIND_LABEL[condition.kind]}</p>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove this rule"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="mt-2">
        <ConditionBody
          condition={condition}
          onChange={onChange}
          onRemove={onRemove}
          depth={depth}
          availableSignals={availableSignals}
          access={access}
        />
      </div>
    </div>
  );
}

function ConditionBody({
  condition,
  onChange,
  onRemove,
  depth,
  availableSignals,
  access,
}: {
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove: () => void;
  depth: number;
  availableSignals: string[];
  access: EditorAccess;
}) {
  switch (condition.kind) {
    case "data": {
      const known = availableSignals.includes(condition.field);
      const options = known ? availableSignals : [condition.field, ...availableSignals];
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <NativeSelect
              aria-label="Signal"
              value={condition.field}
              onChange={(field) => onChange({ ...condition, field })}
              options={options.map((s) => ({ value: s, label: s }))}
            />
            <NativeSelect
              aria-label="Comparison"
              value={condition.operator}
              onChange={(operator) => onChange({ ...condition, operator: operator as ConditionOperator })}
              options={DATA_OPERATORS.map((op) => ({ value: op, label: OPERATOR_LABEL[op] }))}
            />
            {condition.operator !== "is_empty" && condition.operator !== "is_not_empty" && (
              <Input
                aria-label="Comparison value"
                value={typeof condition.value === "string" || typeof condition.value === "number" ? String(condition.value) : ""}
                onChange={(e) => onChange({ ...condition, value: e.target.value })}
                placeholder={condition.operator === "in" ? "comma-separated" : "value"}
                className="h-8 w-28 text-xs"
              />
            )}
          </div>
          {!known && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              This card no longer publishes “{condition.field}” — pick another signal.
            </p>
          )}
        </div>
      );
    }
    case "user":
      return (
        <TagListBody
          legend="Person"
          placeholder="user id"
          values={condition.users}
          onChange={(users) => onChange({ ...condition, users })}
          onEmpty={onRemove}
        />
      );
    case "role":
      return (
        <TagListBody
          legend="Role"
          placeholder="role name or id"
          values={condition.roles}
          onChange={(roles) => onChange({ ...condition, roles })}
          onEmpty={onRemove}
        />
      );
    case "permission":
      return (
        <TagListBody
          legend="Permission"
          placeholder="permission key, e.g. leads.view_all"
          values={condition.permissions}
          onChange={(permissions) => onChange({ ...condition, permissions })}
          onEmpty={onRemove}
          suggestions={access.permissions}
        />
      );
    case "module": {
      // A local const, not a nested `function` declaration: TypeScript does not
      // carry the switch's narrowing of `condition` (to ModuleCondition here)
      // into a hoisted function declaration's body, only into closures created
      // in the normal order of evaluation — so `toggle` has to be one of those.
      const toggle = (id: ModuleId) => {
        const has = condition.modules.includes(id);
        const next = has ? condition.modules.filter((m) => m !== id) : [...condition.modules, id];
        if (next.length === 0) onRemove();
        else onChange({ ...condition, modules: next });
      };
      return (
        <div className="flex flex-wrap gap-1.5">
          {MODULE_REGISTRY.map((mod) => {
            const active = condition.modules.includes(mod.id);
            return (
              <button
                key={mod.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(mod.id)}
                className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                {mod.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "time":
      return <TimeFields condition={condition} onChange={onChange} />;
    case "screen": {
      // Same reason as the module case just above: a `const` closure, not a
      // hoisted function declaration, so the narrowing to ScreenCondition
      // survives into its body.
      const toggle = (bp: (typeof BREAKPOINTS)[number]) => {
        const has = condition.breakpoints.includes(bp);
        const next = has ? condition.breakpoints.filter((b) => b !== bp) : [...condition.breakpoints, bp];
        if (next.length === 0) onRemove();
        else onChange({ ...condition, breakpoints: next });
      };
      return (
        <div className="flex flex-wrap gap-1.5">
          {BREAKPOINTS.map((bp) => {
            const active = condition.breakpoints.includes(bp);
            return (
              <button
                key={bp}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(bp)}
                className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE)}
              >
                {BREAKPOINT_LABEL[bp]}
              </button>
            );
          })}
        </div>
      );
    }
    case "and":
    case "or":
      return (
        <div className="space-y-2 border-l-2 border-border/70 pl-3">
          <ConditionList
            conditions={condition.conditions}
            onChange={(next) => onChange({ ...condition, conditions: next })}
            onDeplete={onRemove}
            minItems={1}
            depth={depth + 1}
            availableSignals={availableSignals}
            access={access}
          />
        </div>
      );
    case "not":
      return (
        <div className="border-l-2 border-border/70 pl-3">
          <ConditionRow
            condition={condition.condition}
            onChange={(inner) => onChange({ ...condition, condition: inner })}
            // A NOT cannot exist without exactly one inner condition, so
            // there is no smaller valid state to fall back to — removing it
            // removes the NOT itself.
            onRemove={onRemove}
            depth={depth + 1}
            availableSignals={availableSignals}
            access={access}
          />
        </div>
      );
  }
}

/* ── time: HH:MM inputs plus a weekday multi-select ───────────────── */

function TimeFields({
  condition,
  onChange,
}: {
  condition: Extract<Condition, { kind: "time" }>;
  onChange: (next: Condition) => void;
}) {
  const afterId = useId();
  const beforeId = useId();
  const weekdays = condition.weekdays ?? [];

  function toggleDay(day: number) {
    const has = weekdays.includes(day);
    const next = has ? weekdays.filter((d) => d !== day) : [...weekdays, day].sort();
    onChange({ ...condition, weekdays: next.length > 0 ? next : undefined });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={afterId} className="text-[11px] text-muted-foreground">
            From
          </Label>
          <Input
            id={afterId}
            type="time"
            value={condition.after ?? ""}
            onChange={(e) => onChange({ ...condition, after: e.target.value || undefined })}
            className="h-8 w-28 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Label htmlFor={beforeId} className="text-[11px] text-muted-foreground">
            Until
          </Label>
          <Input
            id={beforeId}
            type="time"
            value={condition.before ?? ""}
            onChange={(e) => onChange({ ...condition, before: e.target.value || undefined })}
            className="h-8 w-28 text-xs"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {WEEKDAY_LABELS.map((label, day) => {
          const active = weekdays.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={active}
              aria-label={WEEKDAY_FULL[day]}
              onClick={() => toggleDay(day)}
              className={cn(CHIP_BASE, active ? CHIP_ACTIVE : CHIP_INACTIVE)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {!condition.after && !condition.before && weekdays.length === 0 && (
        <p className="text-[11px] text-muted-foreground/70">
          No window set yet — this rule currently matches every time, every day.
        </p>
      )}
    </div>
  );
}

/* ── a chip list with its own "type the first one" composer ──────── */

/**
 * The editing surface for an EXISTING `user` / `role` / `permission`
 * condition — add more values, or remove one. Removing the last one calls
 * `onEmpty` instead of committing an empty array, for the reason the file
 * header explains at length.
 */
function TagListBody({
  legend,
  placeholder,
  values,
  onChange,
  onEmpty,
  suggestions,
}: {
  legend: string;
  placeholder: string;
  values: string[];
  onChange: (next: string[]) => void;
  onEmpty: () => void;
  suggestions?: readonly string[];
}) {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  function add(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setDraft("");
  }

  function remove(v: string) {
    const next = values.filter((x) => x !== v);
    if (next.length === 0) onEmpty();
    else onChange(next);
  }

  const offeredSuggestions = (suggestions ?? []).filter((s) => !values.includes(s));

  return (
    <div className="space-y-1.5">
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {values.map((v) => (
            <li key={v}>
              <button
                type="button"
                onClick={() => remove(v)}
                className="flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-foreground hover:border-destructive/40"
              >
                {v}
                <X className="size-3" aria-hidden="true" />
                <span className="sr-only">Remove {v}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add(draft);
        }}
        className="flex items-center gap-1.5"
      >
        <Label htmlFor={inputId} className="sr-only">
          {legend}
        </Label>
        <Input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
      {offeredSuggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {offeredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── the recursive "add a rule" picker ────────────────────────────── */

type PickerState =
  | { mode: "idle" }
  | { mode: "compose"; kind: "user" | "role" | "permission" }
  | { mode: "nested"; kind: "and" | "or" | "not" };

/**
 * Produces exactly ONE new, already-valid `Condition` and hands it to `onPick`
 * — never before it is valid, which is the whole discipline this file is
 * built around (see the header comment).
 *
 * Three shapes of kind, three internal modes:
 *
 *   SAFE kinds (`data`, `module`, `time`, `screen`) have an obvious first
 *   value — the first signal, the first module, no time restriction, the
 *   first breakpoint — so picking one calls `onPick` immediately.
 *
 *   COMPOSED kinds (`user`, `role`, `permission`) have no safe first value —
 *   see the header on why there is no catalogue to default from — so picking
 *   one switches to a small form that stays open until a real value is typed.
 *
 *   NESTED kinds (`and`, `or`, `not`) need a whole other condition before they
 *   are valid at all. Picking one opens ANOTHER `ConditionPicker`, one depth
 *   deeper, and only calls `onPick` once THAT has produced something — which
 *   is what makes this recursive rather than three special cases.
 */
function ConditionPicker({
  depth,
  availableSignals,
  access,
  onPick,
  triggerLabel,
}: {
  depth: number;
  availableSignals: string[];
  access: EditorAccess;
  onPick: (condition: Condition) => void;
  triggerLabel: string;
}) {
  const [state, setState] = useState<PickerState>({ mode: "idle" });

  if (state.mode === "compose") {
    const kind = state.kind;
    return (
      <ComposeTagInput
        kind={kind}
        suggestions={kind === "permission" ? access.permissions : undefined}
        onAdd={(first) => {
          onPick(seedListCondition(kind, first));
          setState({ mode: "idle" });
        }}
        onCancel={() => setState({ mode: "idle" })}
      />
    );
  }

  if (state.mode === "nested") {
    const kind = state.kind;
    return (
      <div className="space-y-1.5 rounded-lg border border-dashed border-border p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">{NESTED_PROMPT[kind]}</p>
          <button
            type="button"
            onClick={() => setState({ mode: "idle" })}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </button>
        </div>
        <ConditionPicker
          depth={depth + 1}
          availableSignals={availableSignals}
          access={access}
          triggerLabel="Choose a rule"
          onPick={(inner) => {
            onPick(kind === "not" ? { kind: "not", condition: inner } : { kind, conditions: [inner] });
            setState({ mode: "idle" });
          }}
        />
      </div>
    );
  }

  const kinds = CONDITION_KINDS.filter((kind) => {
    if (kind === "data") return availableSignals.length > 0;
    if (kind === "and" || kind === "or" || kind === "not") return depth < MAX_CONDITION_DEPTH;
    return true;
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 text-xs">
          <Plus className="size-3.5" />
          {triggerLabel}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {kinds.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => handlePick(kind)}>
            {KIND_LABEL[kind]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  function handlePick(kind: ConditionKind) {
    if (kind === "user" || kind === "role" || kind === "permission") {
      setState({ mode: "compose", kind });
      return;
    }
    if (kind === "and" || kind === "or" || kind === "not") {
      setState({ mode: "nested", kind });
      return;
    }
    onPick(blankCondition(kind, availableSignals));
  }
}

function ComposeTagInput({
  kind,
  suggestions,
  onAdd,
  onCancel,
}: {
  kind: "user" | "role" | "permission";
  suggestions?: readonly string[];
  onAdd: (first: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = draft.trim();
        if (value) onAdd(value);
      }}
      className="space-y-1.5 rounded-lg border border-dashed border-border p-2"
    >
      <Label htmlFor={inputId} className="text-[11px] text-muted-foreground">
        {COMPOSE_PROMPT[kind]}
      </Label>
      <div className="flex items-center gap-1.5">
        {/* Autofocus is fine here — this form only ever appears in response to
            the person's own click, and the point of it is to type immediately. */}
        <Input
          id={inputId}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={COMPOSE_PLACEHOLDER[kind]}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {suggestions && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onAdd(s)}
              className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** A plain native <select>, for the two-per-row cases too cramped for the full Select primitive's trigger chrome. */
function NativeSelect({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  "aria-label": string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

/* ── blank conditions ─────────────────────────────────────────────── */

function blankCondition(kind: "data" | "module" | "time" | "screen", availableSignals: string[]): Condition {
  switch (kind) {
    case "data":
      return { kind: "data", field: availableSignals[0] ?? "", operator: "is_not_empty" };
    case "module":
      return { kind: "module", modules: [MODULE_REGISTRY[0].id] };
    case "time":
      return { kind: "time" };
    case "screen":
      return { kind: "screen", breakpoints: [BREAKPOINTS[0]] };
  }
}

function seedListCondition(kind: "user" | "role" | "permission", first: string): Condition {
  switch (kind) {
    case "user":
      return { kind: "user", users: [first] };
    case "role":
      return { kind: "role", roles: [first] };
    case "permission":
      return { kind: "permission", permissions: [first] };
  }
}

/* ── static vocabulary ────────────────────────────────────────────── */

const KIND_LABEL: Record<ConditionKind, string> = {
  data: "Only when it has something in it…",
  user: "Only show to specific people…",
  role: "Only for these roles…",
  permission: "Only when you hold…",
  module: "Only when this pack is on…",
  time: "Only between certain times…",
  screen: "Only on certain screen sizes…",
  and: "Only when ALL of these are true…",
  or: "Only when ANY of these are true…",
  not: "Only when this is NOT true…",
};

const NESTED_PROMPT: Record<"and" | "or" | "not", string> = {
  and: "First rule to require:",
  or: "First rule — any one of these will do:",
  not: "The rule to flip:",
};

const COMPOSE_PROMPT: Record<"user" | "role" | "permission", string> = {
  user: "Add the first person",
  role: "Add the first role",
  permission: "Add the first permission",
};

const COMPOSE_PLACEHOLDER: Record<"user" | "role" | "permission", string> = {
  user: "user id",
  role: "role name or id",
  permission: "permission key, e.g. leads.view_all",
};

/**
 * The full operator vocabulary, for `data` conditions — a signal is not typed
 * the way a catalogue field is (see conditions.ts's note on why the FIELD
 * vocabulary is not shared with the journey builder), so there is no
 * `operatorsFor` to narrow this list the way CardBuilder's filters do.
 */
const DATA_OPERATORS: readonly ConditionOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "in",
  "is_empty",
  "is_not_empty",
];

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
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

const BREAKPOINT_LABEL: Record<(typeof BREAKPOINTS)[number], string> = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
};

/** Index = Date#getDay, matching TimeCondition.weekdays. */
const WEEKDAY_LABELS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/*
 * Static class strings only, per this file's Tailwind discipline — every chip
 * toggle below (module, screen, weekday) switches between these two full
 * strings rather than interpolating one.
 */
const CHIP_BASE = "rounded-full border px-2.5 py-1 text-[11px] transition-colors";
const CHIP_ACTIVE = "border-primary/50 bg-primary/10 text-foreground";
const CHIP_INACTIVE = "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground";
