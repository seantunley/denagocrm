import { Check, Minus } from "lucide-react";
import { formatDate, formatZAR, formatZARCompact } from "@/lib/format";
import { resolveField, type ScopeContext } from "@/lib/dashboard/compile";
import type { CardMetric } from "@/lib/dashboard/config";
import type { SourceDef, SourceField } from "@/lib/dashboard/sources";
import type { RenderContext } from "./shell";

/**
 * Turning one row's value into one cell.
 *
 * ── THE DIVISION OF LABOUR, AND WHY IT IS WHERE IT IS ───────────────────────
 *
 * This file does NOT know how to find a value in a row. `cellValues` in
 * lib/dashboard/compile.ts does that — it walks the catalogue path, joins a
 * composite's parts, and, the part that matters, refuses a field this viewer is
 * not entitled to even if the row somehow carries it. A second path walker here
 * would be a second reader of the same vocabulary with the permission check
 * missing from it, and the two would drift one release at a time.
 *
 * So the compiler hands over an array of raw parts and this decides what they
 * LOOK like, driven entirely by `FieldType`. That is the whole reason `FieldType`
 * is a closed union rather than a hint: the editor's operators, its input control
 * and this formatter are three views of one decision, and a field whose type says
 * `money` cannot end up rendered as a bare integer somewhere.
 *
 * MONEY IS CENTS, EVERYWHERE. `valueCents` is what the column is called and what
 * the compiler selects, and every formatter here divides through lib/format's
 * `formatZAR` rather than by hand. A card printing 4 500 000 for R45 000 would be
 * believed, which is the failure worth naming: a wrong number on a dashboard is
 * not caught the way a wrong number on an invoice is.
 */

/** What an absent value looks like. One character, in every cell, always. */
const DASH = "—";

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A database id, as opposed to something a person wrote. cuid and uuid both land
 * in this shape; a name never does. Used for exactly one decision — see below.
 */
const LOOKS_LIKE_AN_ID = /^(c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * A person, from whatever the compiler put in the cell.
 *
 * The `user` field type maps to an id column, so `./people.ts` supplies the
 * names. Three shapes are accepted because a future select could reasonably
 * produce any of them, and the LAST branch is the one that earns its place: an id
 * nobody could resolve renders as a dash, never as the id. A column of
 * `cmk3n1x8p…` teaches users that the column is broken, and printing internal
 * identifiers on a page people screenshot into group chats is a habit worth not
 * acquiring.
 */
function personName(value: unknown, ctx: RenderContext): string {
  if (isBlank(value)) return DASH;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = record.name ?? [record.firstName, record.lastName].filter(Boolean).join(" ");
    return typeof name === "string" && name.trim() !== "" ? name : DASH;
  }
  const id = String(value);
  const resolved = ctx.userNames?.get(id);
  if (resolved) return resolved;
  return LOOKS_LIKE_AN_ID.test(id) ? DASH : id;
}

/** The label a closed set shows, falling back to the stored value. */
function enumLabel(field: SourceField, value: unknown): string {
  const raw = String(value);
  return field.options?.find((o) => o.value === raw)?.label ?? raw;
}

/**
 * Money, at the precision the surface deserves.
 *
 * A list cell gets the exact figure — a column of amounts is read against the
 * one above it, and rounding two of them to "R 45k" hides which is larger. A
 * stat, gauge or chart headline gets the compact form, because that is one
 * number in a tight box and "R 2,27m" is what the existing tiles show.
 */
export function money(cents: number, compact: boolean): string {
  return compact ? formatZARCompact(cents) : formatZAR(cents);
}

/**
 * The plain-text form of a cell, from the parts `cellValues` returned.
 *
 * A composite arrives as several parts and is joined with a space, empties
 * skipped, so a contact with no surname and no company is "Jane" rather than
 * "Jane  " — see SourceField.paths for why a name is one thing to a human and
 * three columns in the database. An empty parts array means the field was
 * refused: the viewer is not entitled to it, and the cell is a dash rather than
 * an explanation.
 */
export function cellText(parts: unknown[], field: SourceField, ctx: RenderContext): string {
  if (parts.length === 0) return DASH;

  if (parts.length > 1) {
    const joined = parts
      .filter((part) => !isBlank(part))
      .map((part) => String(part).trim())
      .filter((part) => part !== "")
      .join(" ");
    return joined === "" ? DASH : joined;
  }

  const raw = parts[0];
  if (isBlank(raw)) return DASH;

  switch (field.type) {
    case "money": {
      const cents = asNumber(raw);
      return cents === null ? DASH : money(cents, false);
    }
    case "number": {
      const n = asNumber(raw);
      return n === null ? DASH : n.toLocaleString("en-ZA");
    }
    case "date":
      // formatDate takes a Date or an ISO string and returns its own dash for
      // null, so a date column needs no second null check here.
      return formatDate(raw as Date | string);
    case "boolean":
      return raw ? "Yes" : "No";
    case "user":
      return personName(raw, ctx);
    case "enum":
      return enumLabel(field, raw);
    default:
      return String(raw);
  }
}

/**
 * The rendered form of a cell.
 *
 * Only booleans differ from their text form: a column of "Yes"/"No" is read word
 * by word, whereas a tick against a dash is read at a glance, which is what a
 * dashboard is for. Everything else is text — and text is safe, because every
 * value here reaches the page as a JSX text node. A customer whose company name
 * is `<script>` is a customer with an odd company name and nothing more.
 */
export function cellValue(
  parts: unknown[],
  field: SourceField,
  ctx: RenderContext,
): React.ReactNode {
  if (field.type === "boolean" && parts.length === 1) {
    const raw = parts[0];
    if (isBlank(raw)) return <Minus className="size-3.5 text-muted-foreground/50" />;
    return raw ? (
      <Check className="size-3.5 text-emerald-400" />
    ) : (
      <Minus className="size-3.5 text-muted-foreground/50" />
    );
  }
  return cellText(parts, field, ctx);
}

/**
 * The field a metric aggregates, or null when there is no such thing.
 *
 * `count` aggregates nothing, whatever it counts. Everything else takes its UNIT
 * from the field underneath it, and the answer has to come from the catalogue
 * rather than from the number that came back — a sum of cents and a sum of
 * estimated hours are both just integers by the time the query returns, and only
 * one of them is R45 000.
 *
 * Resolved through the compiler's own `resolveField` rather than by searching
 * `source.fields` here, for two reasons. It applies the same per-field
 * permission gate the query did, so a card cannot label a value money that the
 * compiler refused to give it. And it is one function: the stat, chart and gauge
 * cards all ask this question, and three cards deciding "is this money?" three
 * ways is how a target ends up compared in the wrong unit.
 */
export function metricField(
  source: SourceDef,
  metric: CardMetric,
  scope: ScopeContext,
): SourceField | null {
  if (metric.fn === "count" || !metric.field) return null;
  return resolveField(source, metric.field, scope, "aggregate");
}

/** Is this metric denominated in cents? Never pattern-match a key to find out. */
export function isMoneyField(field: SourceField | null): boolean {
  return field?.type === "money";
}

/** One metric value as a headline: compact rands, or a grouped integer. */
export function formatMetric(value: number, asMoney: boolean): string {
  if (asMoney) return money(Math.round(value), true);
  // An average is the only metric that arrives fractional, and a tile reading
  // "3.7 leads" is noise — the eye wants the magnitude, not the decimal.
  return Math.round(value).toLocaleString("en-ZA");
}

/**
 * The link a row points at.
 *
 * `SourceDef.href` carries a `:id` placeholder and nothing else, so this is a
 * single substitution rather than a template language. A row with no id yields
 * null and the caller renders plain text instead — a link to `/leads/undefined`
 * is a 404 that looks like the app is broken.
 */
export function rowHref(template: string, row: Record<string, unknown>): string | null {
  const id = row.id;
  if (typeof id !== "string" || id === "") return template.includes(":id") ? null : template;
  return template.replace(":id", encodeURIComponent(id));
}
