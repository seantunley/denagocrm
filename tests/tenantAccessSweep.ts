import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A DEBT RATCHET for tenant access that is outside the app-layer guard. NOT an audit.
 *
 * ── What the guard actually does (src/lib/db.ts) ────────────────────────────────
 * Every model operation on the exported `prisma` client passes through
 * `applyScopeArgs`, which routes it to `scopeArgs(model, kind, args)`:
 *
 *   find… / count / aggregate / groupBy → scopeWhere   → where.tenantId = <scope>
 *   create / createMany                 → stampCreate  → data.tenantId  = <scope>
 *   update… / delete…                   → scopeMutation
 *   upsert                              → scopeUpsert
 *
 * `findUnique` is in the FIRST group. Prisma 6 extendedWhereUnique lets a non-unique
 * field ride alongside the unique selector, so `prisma.quote.findUnique({ where: { id } })`
 * becomes `where: { id, tenantId }` under enforcement. It is scoped. An earlier
 * revision of this sweep called 233 such call sites "unscopable before OR after
 * enforcement"; that was false, and the category is gone. What IS true is much
 * narrower and is not something a static sweep can see: those sites are unscoped
 * only while `tenantEnforcing()` returns false, and the flip FIXES them.
 *
 * So this sweep classifies by CLIENT PROVENANCE, not by method name:
 *
 *   prisma.*      the guarded client — scoped under enforcement. NOT a finding.
 *   basePrisma.*  the documented RLS bypass (`app.bypass_rls='on'`). A finding
 *                 unless the call names a tenant itself.
 *   tx.*          depends entirely on which client opened the transaction, so the
 *                 receiver is resolved back to its `$transaction` call site.
 *   anything else unresolved provenance → a finding. Fail closed, never open.
 *
 * ── Raw SQL is two different things ─────────────────────────────────────────────
 * db.ts Layer 2b wraps the raw methods on BOTH clients, and they set OPPOSITE GUCs:
 *   prisma.$queryRaw      → SET LOCAL app.current_tenant → RLS bounds the statement
 *   basePrisma.$queryRaw  → SET LOCAL app.bypass_rls     → nothing bounds it
 * Lumping those together was the second error in the earlier revision. They are
 * separate categories here: `scoped-raw` (weaker — outside the app guard, RLS only)
 * and `bypass-raw` (unbounded). Layer 2b patches those methods as OWN PROPERTIES of
 * the two exported client objects, so only a literal `prisma.` / `basePrisma.`
 * receiver gets the treatment: raw SQL on an interactive `tx` from
 * `prisma.$transaction` sets no GUC at all and lands in `unknown-client`.
 *
 * ── What this sweep CANNOT see ─────────────────────────────────────────────────
 * See the header of tenantAccessRatchet.test.ts. It is a long list, and a shrinking
 * number here is not evidence of tenant isolation.
 */

export type FindingKind =
  /** basePrisma (or a bypass `tx`) reading a tenant-owned model with no tenant filter. */
  | "bypass-read"
  /** basePrisma (or a bypass `tx`) writing a tenant-owned model with no tenant stamp. */
  | "bypass-write"
  /** basePrisma raw SQL on a tenant-owned table with no tenant predicate — sets
   *  app.bypass_rls, so neither the guard nor RLS bounds it. */
  | "bypass-raw"
  /** `prisma` raw SQL on a tenant-owned table with no tenant predicate. Bounded by
   *  RLS (Layer 2b sets app.current_tenant) but NOT by the app-layer guard, and RLS
   *  is only real for a role without BYPASSRLS. Lower severity than bypass-raw. */
  | "scoped-raw"
  /** A client this sweep cannot show is scoped: a `tx`/`client`/`db` parameter handed
   *  in from elsewhere, a `(a ?? b).x` receiver, or raw SQL on an interactive `tx`
   *  (which Layer 2b's per-client raw patch does not reach). Counted as a finding
   *  because the alternative is assuming it was the guarded client. */
  | "unknown-client"
  /** A tenant-facing surface enumerating the global `User` table instead of
   *  listTenantStaff(), which shows other workspaces' people in pickers. */
  | "global-user";

export type Finding = {
  kind: FindingKind;
  file: string;
  model: string;
  line: number;
  /** The receiver identifier, for the failure message ("basePrisma", "tx", "client"). */
  via: string;
};

export type SweepStats = {
  files: number;
  /** Model ops on the guarded client. Not findings — a liveness signal for the scanner. */
  guardedModelOps: number;
};

const SCHEMA_DIR = "prisma";
const SOURCE_DIR = "src";

/** Models that own a `tenantId` column, minus the ones deliberately global. */
export function tenantOwnedModels(root: string, globalModels: ReadonlySet<string>): Set<string> {
  const models = new Set<string>();
  for (const name of readdirSync(path.join(root, SCHEMA_DIR))) {
    if (!name.endsWith(".prisma")) continue;
    const schema = readFileSync(path.join(root, SCHEMA_DIR, name), "utf8");
    for (const match of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)) {
      if (/^\s*tenantId\s/m.test(match[2]) && !globalModels.has(match[1])) models.add(match[1]);
    }
  }
  return models;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(path.join(root, SOURCE_DIR));
  return out;
}

/* ────────────────────────────── masking ──────────────────────────────────────
 * Two views of the file, both the SAME LENGTH as the original (so every index and
 * therefore every line number still lines up):
 *
 *   structural — comments blanked AND string / template / regex CONTENTS blanked.
 *                Braces and parens inside literals disappear, so brace balancing
 *                is sound, and the word "tenantId" inside a comment or a string can
 *                no longer excuse an unscoped call. That false negative — a comment
 *                near a bypass write making it vanish from the report — was the
 *                worst defect in the earlier revision, because it produced green CI.
 *   sql        — comments blanked, string bodies KEPT, so raw SQL text is readable.
 *
 * A single- or double-quoted literal must close on the same line; if it does not we
 * assume it was never a string (JSX prose: `Don't`), so a stray apostrophe cannot
 * swallow the rest of a .tsx file.
 */
export function maskSource(source: string): { structural: string; sql: string } {
  const structural = source.split("");
  const sql = source.split("");

  const blank = (target: string[], from: number, to: number) => {
    for (let i = Math.max(0, from); i < to && i < target.length; i++) {
      if (target[i] !== "\n" && target[i] !== "\r") target[i] = " ";
    }
  };

  const quoteEnd = (from: number, quote: string): number => {
    for (let i = from + 1; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (c === "\n") return -1;
      if (c === quote) return i;
    }
    return -1;
  };

  /**
   * `depth` counts BRACES INSIDE an interpolation, not interpolations. A raw SQL
   * template can legitimately contain a bare `}` in its text — a regex quantifier
   * such as `([0-9]{1,6})` — and treating that as the close of a `${` ended the
   * template early, which shortened the call extent and lost the query's table name.
   * A nested template inside an interpolation is skipped whole, recursively.
   */
  const templateEnd = (from: number): number => {
    let depth = 0;
    for (let i = from + 1; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (depth === 0) {
        if (c === "`") return i;
        if (c === "$" && source[i + 1] === "{") { depth = 1; i++; }
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "`") {
        const nested = templateEnd(i);
        if (nested === -1) return -1;
        i = nested;
      }
    }
    return -1;
  };

  const REGEX_PREFIX = /(?:[(,=:[!&|?{};+\-*%~^<>]|\b(?:return|typeof|case|in|of|new|delete|void|instanceof|do|else|yield|await))$/;
  const startsRegex = (at: number): boolean => {
    const before = source.slice(Math.max(0, at - 16), at).replace(/\s+$/, "");
    return before === "" ? true : REGEX_PREFIX.test(before);
  };
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let i = from + 1; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (c === "\n") return -1;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return i;
    }
    return -1;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
      blank(structural, i, end);
      blank(sql, i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      blank(structural, i, end);
      blank(sql, i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = quoteEnd(i, c);
      if (end === -1) { i++; continue; }
      blank(structural, i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === "`") {
      const end = templateEnd(i);
      if (end === -1) { i++; continue; }
      blank(structural, i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === "/" && startsRegex(i)) {
      const end = regexEnd(i);
      if (end !== -1) {
        blank(structural, i + 1, end);
        i = end + 1;
        continue;
      }
    }
    i++;
  }

  return { structural: structural.join(""), sql: sql.join("") };
}

/**
 * The balanced span of an argument list / template starting at `open`. Because
 * literals are already blanked in `structural`, plain counting is correct.
 * Returns the index just past the closing delimiter.
 */
function balancedEnd(structural: string, open: number): number {
  let depth = 0;
  const limit = Math.min(structural.length, open + 20_000);
  for (let i = open; i < limit; i++) {
    const c = structural[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return limit;
}

/**
 * Step over whitespace and an explicit type argument list to reach a call's opening
 * backtick or paren. `$queryRaw` is almost always written with one here —
 * `basePrisma.$queryRaw<Array<{ id: string }>>` — and the nested `<` and `{` in it
 * defeat a naive `<[^<>]*>` skip. A first cut of this rewrite did exactly that and
 * silently stopped reporting 30-odd genuine bypass reads, which is the same class of
 * failure (a pattern that quietly matches nothing) this whole file exists to prevent.
 */
function afterCallPrefix(structural: string, from: number): number {
  let at = from;
  while (at < structural.length && /\s/.test(structural[at])) at++;
  if (structural[at] !== "<") return at;
  let depth = 0;
  const limit = Math.min(structural.length, at + 600);
  for (let i = at; i < limit; i++) {
    const c = structural[i];
    if (c === "=" && structural[i + 1] === ">") { i++; continue; } // arrow inside a fn type
    if (c === "<") depth++;
    else if (c === ">") {
      depth--;
      if (depth === 0) {
        at = i + 1;
        while (at < structural.length && /\s/.test(structural[at])) at++;
        return at;
      }
    } else if (c === "`") break; // ran into the template without closing: not a type list
    // NB: no `;` guard. TS type literals separate members with semicolons —
    // `$queryRaw<Array<{ id: string; total: bigint }>>` — and treating one as the end
    // of the type list dropped every raw query written in that (very common) style.
  }
  return at;
}

/* ────────────────────────── the tenant heuristic ─────────────────────────────
 * Applied ONLY to a call's own balanced argument list, on the structural view, so
 * it can no longer be satisfied by a comment or a string somewhere in the vicinity.
 * Deliberately a short, closed list of the identifiers this codebase actually uses
 * to carry a tenant into an unguarded call.
 */
const NAMES_A_TENANT =
  /\b(?:tenantId|tenant_id|tenantFilter|writeTenantId|actingTenantId|activeTenantId|currentTenantScope|tenantScope|scopeToTenant|flowScope|sharedInTenant|journeyTenantFilter)\b/;

/** A tenant predicate inside raw SQL text (the `sql` view keeps string bodies). */
const SQL_NAMES_A_TENANT = /tenantId|tenant_id|app\.current_tenant/i;

/**
 * SQL comments live INSIDE a template literal, so the JS-level comment masking never
 * touches them. Strip them before asking whether the statement names a tenant, for
 * the same reason the JS masking exists: an explanatory `-- scoped by tenantId
 * upstream` must not be able to talk a query out of the report.
 */
const stripSqlComments = (statement: string) =>
  statement.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const READ_OPS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow",
  "count", "aggregate", "groupBy",
]);
const WRITE_OPS = new Set([
  "create", "createMany", "createManyAndReturn", "update", "updateMany",
  "updateManyAndReturn", "upsert", "delete", "deleteMany",
]);

/**
 * The receiver is either an identifier or a `)` — `(tx ?? basePrisma).$queryRaw` is
 * a real shape in this codebase (accessControl, userSecurity, settings) and an
 * identifier-only pattern skipped every one of them. A parenthesised receiver cannot
 * be resolved statically, so it lands in `unknown-client`.
 */
const MODEL_OP = new RegExp(
  String.raw`(?:\b(\w+)|\))\s*\.([a-z]\w*)\.(` + [...READ_OPS, ...WRITE_OPS].join("|") + String.raw`)\s*\(`,
  "g",
);
const RAW_OP = /(?:\b(\w+)|\))\s*\.(\$(?:query|execute)Raw(?:Unsafe)?)\b/g;
/** Receiver label for an expression we cannot name. Never resolves to a span. */
const UNRESOLVABLE = "(expression)";
const GLOBAL_USER = /(?:\b(\w+)|\))\s*\.user\.(?:findMany|findFirst)\s*\(/g;
const TX_CALLBACK = /\b(\w+)\.\$transaction\s*\(\s*(?:async\s+)?(?:\(\s*(\w+)|(\w+)\s*=>)/g;
/**
 * The bypass-transaction helpers, as a CLOSED LIST of names.
 *
 * All three open their transaction on `basePrisma` and hand the callback a tenantId
 * for it to stamp with — `withTenantWrite` resolves the founding tenant,
 * `withActingTenantWrite` (#473) resolves the ACTING workspace,
 * `withBotConversationWrite` resolves the workspace a bot conversation belongs to.
 * That is a different ANSWER for the tenantId, not a different client, so a `tx`
 * from any of them has the same provenance: bypass, with an explicit stamp
 * available but not applied for you.
 *
 * Each of the two newer ones fell through to `unknown-client` on the run that
 * introduced it, before it was named here. That is the correct default — an
 * unrecognised helper must never be assumed guarded — and it is why this stays a
 * list of names rather than a `with\w*TenantWrite` wildcard, which would silently
 * adopt the next helper someone writes before anyone had decided which client it
 * opens on.
 */
const TENANT_WRITE_HELPERS = [
  "withTenantWrite",
  "withActingTenantWrite",
  "withBotConversationWrite",
] as const;
const TENANT_WRITE_CALLBACK = new RegExp(
  String.raw`\b(?:` + TENANT_WRITE_HELPERS.join("|") + String.raw`)\s*(?=[<(])`,
  "g",
);
/**
 * The callback's first parameter, matched AT the call's opening paren — which is
 * found with `afterCallPrefix`, not by counting characters, because these helpers
 * are also called with an explicit type argument:
 * `withActingTenantWrite<{ id: string }>((tx, tenantId) => …)` in fleets.ts. A
 * fixed-offset `indexOf("(")` lands inside `<{ id: string }>` there and resolves
 * the wrong span. Failing to match here loses the span and the `tx` falls back to
 * `unknown-client`, so this errs closed like everything else in the file.
 */
const CALLBACK_PARAM = /^\(\s*(?:async\s+)?(?:\(\s*(\w+)|(\w+)\s*=>)/;
/** Raw SQL table references. Prisma raw in this codebase always quotes model tables. */
const SQL_TABLE = /(?:FROM|INTO|UPDATE|JOIN)\s+"(\w+)"/gi;

/** Where a client came from. `bypass` covers basePrisma AND withTenantWrite's tx. */
type Provenance = "guarded" | "bypass" | "unknown";
type ClientSpan = { start: number; end: number; name: string; provenance: Provenance };

function lineFinder(source: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (index: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Resolve a receiver identifier to a provenance at a given offset.
 *
 * `prisma` and `basePrisma` are the two module-level clients and are known
 * outright. Everything else must be inside a transaction callback whose receiver
 * we resolved — the INNERMOST enclosing span wins, so a bypass transaction nested
 * in a guarded one is still bypass. No enclosing span → `unknown`, which counts.
 */
function provenanceOf(name: string, at: number, spans: readonly ClientSpan[]): Provenance {
  if (name === "prisma") return "guarded";
  if (name === "basePrisma") return "bypass";
  let best: ClientSpan | null = null;
  for (const span of spans) {
    if (span.name !== name || at < span.start || at >= span.end) continue;
    if (!best || span.end - span.start < best.end - best.start) best = span;
  }
  return best ? best.provenance : "unknown";
}

/** Every transaction callback in the file, with the provenance of its `tx`. */
function transactionSpans(structural: string): ClientSpan[] {
  const spans: ClientSpan[] = [];

  const pending: { start: number; open: number; name: string; receiver: string | null }[] = [];
  for (const m of structural.matchAll(TX_CALLBACK)) {
    const name = m[2] ?? m[3];
    if (!name) continue;
    const open = structural.indexOf("(", m.index + m[1].length + "$transaction".length + 1);
    if (open === -1) continue;
    pending.push({ start: m.index, open, name, receiver: m[1] });
  }
  for (const m of structural.matchAll(TENANT_WRITE_CALLBACK)) {
    const open = afterCallPrefix(structural, m.index + m[0].length);
    if (structural[open] !== "(") continue; // not a call — an import, a reference
    const param = CALLBACK_PARAM.exec(structural.slice(open, open + 200));
    const name = param?.[1] ?? param?.[2];
    // No inline callback here: the helper's own declaration (`fn: (tx, …) => …`),
    // or a callback passed by reference. Nothing to bind a `tx` name to, so no span.
    if (!name) continue;
    // These helpers run their callback on basePrisma and hand back a tenantId for
    // the caller to stamp. Bypass with an explicit stamp available — still bypass.
    pending.push({ start: m.index, open, name, receiver: null });
  }

  // Outermost first, so a nested transaction can inherit from the one containing it.
  pending.sort((a, b) => a.start - b.start);
  for (const call of pending) {
    const end = balancedEnd(structural, call.open);
    const provenance =
      call.receiver === null ? "bypass" : provenanceOf(call.receiver, call.start, spans);
    spans.push({ start: call.open, end, name: call.name, provenance });
  }
  return spans;
}

/**
 * Classify one file. Exported so the test suite can drive it with synthetic source
 * strings — the detector is proved against known positives and known negatives it
 * holds itself, not against whatever debt the real codebase happens to contain.
 */
export function analyzeSource(
  file: string,
  source: string,
  models: ReadonlySet<string>,
): { findings: Finding[]; guardedModelOps: number } {
  const normalized = source.replace(/\r\n/g, "\n");
  const { structural, sql } = maskSource(normalized);
  const lineAt = lineFinder(normalized);
  const byProperty = new Map([...models].map((m) => [m[0].toLowerCase() + m.slice(1), m]));
  const spans = transactionSpans(structural);
  const findings: Finding[] = [];
  let guardedModelOps = 0;

  // ── model operations ────────────────────────────────────────────────────────
  for (const m of structural.matchAll(MODEL_OP)) {
    const model = byProperty.get(m[2]);
    if (!model) continue; // not a tenant-owned model (or not Prisma at all)
    const via = m[1] ?? UNRESOLVABLE;
    const provenance = provenanceOf(via, m.index, spans);
    if (provenance === "guarded") {
      guardedModelOps++;
      continue; // the guard scopes this under enforcement — deliberately not a finding
    }
    const open = m.index + m[0].length - 1;
    if (NAMES_A_TENANT.test(structural.slice(open, balancedEnd(structural, open)))) continue;
    const kind: FindingKind =
      provenance === "unknown" ? "unknown-client" : READ_OPS.has(m[3]) ? "bypass-read" : "bypass-write";
    findings.push({ kind, file, model, line: lineAt(m.index), via });
  }

  // ── raw SQL ─────────────────────────────────────────────────────────────────
  for (const m of structural.matchAll(RAW_OP)) {
    const via = m[1] ?? UNRESOLVABLE;
    const provenance = provenanceOf(via, m.index, spans);
    // Extent of the call: a tagged template, or an argument list. Read the TEXT out
    // of the `sql` view (string bodies intact) so the table and any tenant predicate
    // are visible, while the extent itself is measured on the balanced structural view.
    const at = afterCallPrefix(structural, m.index + m[0].length);
    let end: number;
    if (structural[at] === "`") {
      const close = structural.indexOf("`", at + 1);
      end = close === -1 ? at + 1 : close + 1;
    } else if (structural[at] === "(") {
      end = balancedEnd(structural, at);
    } else {
      continue; // a reference to the method, not a call
    }
    const statement = stripSqlComments(sql.slice(at, end));
    const tables = [...statement.matchAll(SQL_TABLE)].map((t) => t[1]).filter((t) => models.has(t));
    if (tables.length === 0) continue; // no tenant-owned table named (set_config, global tables)
    if (SQL_NAMES_A_TENANT.test(statement)) continue;
    // Layer 2b patches `$queryRaw` and friends as OWN PROPERTIES of the two exported
    // client objects. An interactive transaction client is a different object built
    // by Prisma, so it does NOT carry that patch: raw SQL on a `tx` from
    // `prisma.$transaction` sets no GUC at all and is neither guarded nor RLS-bounded,
    // however scoped it looks. Only a literal `prisma.` receiver earns `scoped-raw`.
    // A `tx` from `basePrisma.$transaction` IS bypassed, because buildBypassClient's
    // patched interactive $transaction sets app.bypass_rls at the top of the callback.
    const kind: FindingKind =
      via === "prisma" ? "scoped-raw" : provenance === "bypass" ? "bypass-raw" : "unknown-client";
    findings.push({ kind, file, model: tables[0], line: lineAt(m.index), via });
  }

  // ── the global User table on a tenant-facing surface ────────────────────────
  if (/^src\/app\/\(app\)\//.test(file) || /^src\/components\//.test(file)) {
    for (const m of structural.matchAll(GLOBAL_USER)) {
      const open = m.index + m[0].length - 1;
      if (NAMES_A_TENANT.test(structural.slice(open, balancedEnd(structural, open)))) continue;
      findings.push({ kind: "global-user", file, model: "User", line: lineAt(m.index), via: m[1] ?? UNRESOLVABLE });
    }
  }

  return { findings, guardedModelOps };
}

export function sweep(
  root: string,
  globalModels: ReadonlySet<string>,
): { findings: Finding[]; stats: SweepStats } {
  const models = tenantOwnedModels(root, globalModels);
  const files = sourceFiles(root);
  const findings: Finding[] = [];
  let guardedModelOps = 0;
  for (const full of files) {
    const rel = path.relative(root, full).replace(/\\/g, "/");
    const result = analyzeSource(rel, readFileSync(full, "utf8"), models);
    findings.push(...result.findings);
    guardedModelOps += result.guardedModelOps;
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
  return { findings, stats: { files: files.length, guardedModelOps } };
}

/**
 * Baseline key: file + kind + model, NOT line — editing above a finding does not
 * invent a new one.
 */
export const findingKey = (f: Finding) => `${f.file}::${f.kind}::${f.model}`;

export function tally(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[findingKey(f)] = (counts[findingKey(f)] ?? 0) + 1;
  return counts;
}

export function countsByKind(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return counts;
}

/**
 * The ONLY way the fixture is allowed to change.
 *
 * The earlier revision wrote the fixture at module scope BEFORE the assertions ran,
 * so `UPDATE_TENANT_BASELINE=1` on a run that had just introduced a violation
 * recorded it and the next run was green. A ratchet that can go up is not a ratchet.
 *
 * This cannot raise a number even if it is called at the wrong moment, on the wrong
 * branch, by someone who has not read any of this:
 *   - every retained entry is min(existing, current), so no entry can grow;
 *   - a key that is absent from `existing` has an implicit allowance of 0, so a NEW
 *     finding is an increase;
 *   - ANY increase refuses the whole write and names the key and the delta.
 * Entries that dropped to zero are removed, so a fixed site cannot silently return.
 */
export function nextBaseline(
  existing: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): { ok: true; baseline: Record<string, number>; lowered: string[] } | { ok: false; increases: string[] } {
  const increases: string[] = [];
  for (const [key, count] of Object.entries(current)) {
    const allowed = existing[key] ?? 0;
    if (count > allowed) increases.push(`${key}  (allowed ${allowed}, now ${count}, +${count - allowed})`);
  }
  if (increases.length > 0) return { ok: false, increases: increases.sort() };

  const baseline: Record<string, number> = {};
  const lowered: string[] = [];
  for (const key of Object.keys(existing).sort()) {
    const allowed = existing[key];
    const kept = Math.min(allowed, current[key] ?? 0);
    if (kept !== allowed) lowered.push(`${key}  (${allowed} → ${kept})`);
    if (kept > 0) baseline[key] = kept;
  }
  return { ok: true, baseline, lowered };
}
