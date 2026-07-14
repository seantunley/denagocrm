/**
 * Safe expression engine for conditional document content.
 *
 * Powers conditions like:
 *   quotation.discount > 0
 *   customer.type == "Enterprise"
 *   quotation.lines.length > 0 && quotation.total > 10000
 *
 * NO eval, NO Function, NO arbitrary JS — a tiny recursive-descent parser over a
 * fixed grammar that only reads values out of a supplied scope object. Hard
 * limits on input length and nesting depth guard against pathological input.
 * Templates are owner-authored but still treated as untrusted content.
 */

const MAX_EXPR_LENGTH = 500;
const MAX_DEPTH = 24;
const MAX_TOKENS = 200;

type Tok =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "ident"; v: string }
  | { k: "op"; v: string }
  | { k: "lparen" }
  | { k: "rparen" }
  | { k: "dot" };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "<", ">", "!"];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "(") { toks.push({ k: "lparen" }); i++; continue; }
    if (c === ")") { toks.push({ k: "rparen" }); i++; continue; }
    if (c === ".") { toks.push({ k: "dot" }); i++; continue; }
    // string literal
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < n) { out += src[j + 1]; j += 2; continue; }
        out += src[j]; j++;
      }
      if (j >= n) throw new ExprError("Unterminated string literal");
      toks.push({ k: "str", v: out });
      i = j + 1;
      continue;
    }
    // number
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < n && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) {
        // stop at a dot that is followed by a non-digit (path access), keep decimal dots
        if (src[j] === "." && !(j + 1 < n && src[j + 1] >= "0" && src[j + 1] <= "9")) break;
        j++;
      }
      toks.push({ k: "num", v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    // operator
    const two = src.slice(i, i + 2);
    if (OPS.includes(two)) { toks.push({ k: "op", v: two }); i += 2; continue; }
    if (OPS.includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }
    // identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "true") toks.push({ k: "bool", v: true });
      else if (word === "false") toks.push({ k: "bool", v: false });
      else if (word === "null") toks.push({ k: "null" });
      else toks.push({ k: "ident", v: word });
      i = j;
      continue;
    }
    throw new ExprError(`Unexpected character “${c}”`);
  }
  return toks;
}

export class ExprError extends Error {}

type Node =
  | { t: "lit"; v: unknown }
  | { t: "path"; parts: string[] }
  | { t: "unary"; op: string; a: Node }
  | { t: "bin"; op: string; a: Node; b: Node };

/** Recursive-descent parser: or → and → equality → comparison → unary → primary. */
class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private next(): Tok | undefined { return this.toks[this.pos++]; }
  private isOp(v: string): boolean { const t = this.peek(); return !!t && t.k === "op" && t.v === v; }

  parse(): Node {
    const node = this.or(0);
    if (this.pos < this.toks.length) throw new ExprError("Unexpected trailing input");
    return node;
  }

  private guard(depth: number) { if (depth > MAX_DEPTH) throw new ExprError("Expression too deeply nested"); }

  private or(depth: number): Node {
    this.guard(depth);
    let left = this.and(depth + 1);
    while (this.isOp("||")) { this.next(); left = { t: "bin", op: "||", a: left, b: this.and(depth + 1) }; }
    return left;
  }
  private and(depth: number): Node {
    this.guard(depth);
    let left = this.equality(depth + 1);
    while (this.isOp("&&")) { this.next(); left = { t: "bin", op: "&&", a: left, b: this.equality(depth + 1) }; }
    return left;
  }
  private equality(depth: number): Node {
    this.guard(depth);
    let left = this.comparison(depth + 1);
    while (this.isOp("==") || this.isOp("!=")) {
      const op = (this.next() as { v: string }).v;
      left = { t: "bin", op, a: left, b: this.comparison(depth + 1) };
    }
    return left;
  }
  private comparison(depth: number): Node {
    this.guard(depth);
    let left = this.unary(depth + 1);
    while (this.isOp("<") || this.isOp(">") || this.isOp("<=") || this.isOp(">=")) {
      const op = (this.next() as { v: string }).v;
      left = { t: "bin", op, a: left, b: this.unary(depth + 1) };
    }
    return left;
  }
  private unary(depth: number): Node {
    this.guard(depth);
    if (this.isOp("!")) { this.next(); return { t: "unary", op: "!", a: this.unary(depth + 1) }; }
    return this.primary(depth + 1);
  }
  private primary(depth: number): Node {
    this.guard(depth);
    const t = this.next();
    if (!t) throw new ExprError("Unexpected end of expression");
    if (t.k === "num") return { t: "lit", v: t.v };
    if (t.k === "str") return { t: "lit", v: t.v };
    if (t.k === "bool") return { t: "lit", v: t.v };
    if (t.k === "null") return { t: "lit", v: null };
    if (t.k === "lparen") {
      const inner = this.or(depth + 1);
      const close = this.next();
      if (!close || close.k !== "rparen") throw new ExprError("Missing closing parenthesis");
      return inner;
    }
    if (t.k === "ident") {
      const parts = [t.v];
      while (this.peek()?.k === "dot") {
        this.next();
        const id = this.next();
        if (!id || id.k !== "ident") throw new ExprError("Expected property name after “.”");
        parts.push(id.v);
      }
      return { t: "path", parts };
    }
    throw new ExprError("Unexpected token");
  }
}

const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Resolve a dotted path against the scope; `.length` works on arrays and strings. */
function resolvePath(parts: string[], scope: Record<string, unknown>): unknown {
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (p === "length" && (Array.isArray(cur) || typeof cur === "string")) return cur.length;
    if (BLOCKED_KEYS.has(p)) return undefined; // no prototype-gadget access
    if (typeof cur !== "object") return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, p) ? (cur as Record<string, unknown>)[p] : undefined;
  }
  return cur;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return Boolean(v);
}
function looseEq(a: unknown, b: unknown): boolean {
  const an = toNum(a), bn = toNum(b);
  if (an != null && bn != null) return an === bn;
  if (a == null || b == null) return (a == null) === (b == null);
  return String(a) === String(b);
}

function evalNode(node: Node, scope: Record<string, unknown>): unknown {
  switch (node.t) {
    case "lit": return node.v;
    case "path": return resolvePath(node.parts, scope);
    case "unary": return !truthy(evalNode(node.a, scope));
    case "bin": {
      if (node.op === "&&") return truthy(evalNode(node.a, scope)) && truthy(evalNode(node.b, scope));
      if (node.op === "||") return truthy(evalNode(node.a, scope)) || truthy(evalNode(node.b, scope));
      const a = evalNode(node.a, scope);
      const b = evalNode(node.b, scope);
      switch (node.op) {
        case "==": return looseEq(a, b);
        case "!=": return !looseEq(a, b);
        case "<": case ">": case "<=": case ">=": {
          const an = toNum(a), bn = toNum(b);
          if (an == null || bn == null) return false; // non-numeric comparisons are false, never throw
          return node.op === "<" ? an < bn : node.op === ">" ? an > bn : node.op === "<=" ? an <= bn : an >= bn;
        }
      }
      return false;
    }
  }
}

function parse(expr: string): Node {
  if (expr.length > MAX_EXPR_LENGTH) throw new ExprError("Expression too long");
  const toks = tokenize(expr);
  if (toks.length === 0) throw new ExprError("Empty expression");
  if (toks.length > MAX_TOKENS) throw new ExprError("Expression too complex");
  return new Parser(toks).parse();
}

/** Validate an expression for the editor. Returns a human-readable error or null. */
export function validateExpression(expr: string): string | null {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return null; // empty = "always show", not an error
  try { parse(trimmed); return null; }
  catch (e) { return e instanceof ExprError ? e.message : "Invalid expression"; }
}

/**
 * Evaluate a condition against a data scope.
 * Empty expression → true (always show). Parse/eval errors → `onError` (default
 * true, i.e. fail-open so content is never silently lost from a typo).
 */
export function evaluateCondition(expr: string, scope: Record<string, unknown>, onError = true): boolean {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return true;
  try {
    return truthy(evalNode(parse(trimmed), scope));
  } catch {
    return onError;
  }
}
