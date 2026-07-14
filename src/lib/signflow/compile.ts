/**
 * Compile a signing workflow into an ordered signer chain for a specific record.
 * Pure: walks the graph from `start`, evaluating condition nodes against the
 * record's context, collecting signer steps in order. No DB access — the caller
 * supplies the resolved customer + a staff lookup.
 */
import type { WorkflowGraph, SignNode, SignerWho, ConditionNode, ConditionOp } from "./model";

export type WorkflowContext = {
  total: number;    // quote total incl VAT, in rand
  discount: number; // percent (0 when none)
  segment: string;  // customer segment, e.g. retail | dealer | fleet
  product: string;  // product / model name
};

export type ResolvedSigner = {
  nodeId: string;
  label: string;
  role: "signer" | "approver";
  mode: SignerWho["mode"];
  name: string;
  email: string | null;
  needsInput: boolean; // true → sender must supply the contact (role / ask, unresolved)
  roleHint: string | null;
};

export type CompileResult = { signers: ResolvedSigner[]; errors: string[] };

function num(s: string): number {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function evalCondition(node: ConditionNode, ctx: WorkflowContext): boolean {
  const { field, op, value } = node;
  if (field === "total" || field === "discount") {
    const a = field === "total" ? ctx.total : ctx.discount;
    const b = num(value);
    if (Number.isNaN(b)) return false;
    return cmpNum(a, op, b);
  }
  // string fields: segment / product
  const a = String(field === "segment" ? ctx.segment : ctx.product).toLowerCase().trim();
  const b = value.toLowerCase().trim();
  switch (op) {
    case "eq": return a === b;
    case "neq": return a !== b;
    case "contains": return a.includes(b);
    default: return false; // numeric ops don't apply to strings
  }
}

function cmpNum(a: number, op: ConditionOp, b: number): boolean {
  switch (op) {
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    case "lte": return a <= b;
    case "eq": return a === b;
    case "neq": return a !== b;
    case "contains": return false;
  }
}

function resolveWho(who: SignerWho, opts: { customer: { name: string; email: string | null }; staff: Record<string, { name: string; email: string | null }> }): { name: string; email: string | null; needsInput: boolean; roleHint: string | null } {
  switch (who.mode) {
    case "customer":
      return { name: opts.customer.name || "Customer", email: opts.customer.email, needsInput: false, roleHint: null };
    case "staff": {
      const u = who.userId ? opts.staff[who.userId] : undefined;
      if (u) return { name: u.name, email: u.email, needsInput: false, roleHint: null };
      return { name: who.name || "Denago", email: who.email ?? null, needsInput: !who.email, roleHint: null };
    }
    case "email":
      return { name: who.name || who.email || "Recipient", email: who.email ?? null, needsInput: !who.email, roleHint: null };
    case "role":
      return { name: who.name || who.role || "Approver", email: who.email ?? null, needsInput: !who.email, roleHint: who.role ?? null };
    case "ask":
      return { name: who.name || "To be chosen", email: null, needsInput: true, roleHint: null };
  }
}

export function compileWorkflow(
  graph: WorkflowGraph,
  opts: { vars: WorkflowContext; customer: { name: string; email: string | null }; staff?: Record<string, { name: string; email: string | null }> }
): CompileResult {
  const staff = opts.staff ?? {};
  const signers: ResolvedSigner[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();

  let cur: string | undefined = graph.start;
  let steps = 0;
  while (cur && steps++ < 200) {
    if (visited.has(cur)) { errors.push(`Loop detected at ${cur}`); break; }
    visited.add(cur);
    const node: SignNode | undefined = graph.nodes[cur];
    if (!node) { errors.push(`Missing node ${cur}`); break; }

    if (node.type === "start") { cur = node.next; continue; }
    if (node.type === "end") break;
    if (node.type === "condition") {
      cur = evalCondition(node, opts.vars) ? node.whenTrue : node.whenFalse;
      continue;
    }
    // signer
    const r = resolveWho(node.who, { customer: opts.customer, staff });
    signers.push({ nodeId: node.id, label: node.label || r.name, role: node.role, mode: node.who.mode, name: r.name, email: r.email, needsInput: r.needsInput, roleHint: r.roleHint });
    cur = node.next;
  }

  if (signers.length === 0) errors.push("Workflow produced no signers.");
  return { signers, errors };
}
