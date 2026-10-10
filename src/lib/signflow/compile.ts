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

export function evalCondition(node: ConditionNode, ctx: WorkflowContext): boolean {
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
      return { name: who.name || "Our team", email: who.email ?? null, needsInput: !who.email, roleHint: null };
    }
    case "email":
      return { name: who.name || who.email || "Recipient", email: who.email ?? null, needsInput: !who.email, roleHint: null };
    case "role":
      return { name: who.name || who.role || "Approver", email: who.email ?? null, needsInput: !who.email, roleHint: who.role ?? null };
    case "owner":
      return { name: who.name || "Owner", email: who.email ?? null, needsInput: false, roleHint: "owner" };
    case "ask":
      return { name: who.name || "To be chosen", email: null, needsInput: true, roleHint: null };
  }
}

/** A step whose person the workflow leaves to whoever sends the document. */
export type WorkflowAsk = {
  nodeId: string;
  /** What the step is called on the canvas, e.g. "Finance approval". */
  label: string;
  kind: "signer" | "approver";
  /** The role the designer had in mind, when they named one. */
  hint: string | null;
};

/** Who the sender put in a step: one of the team, or somebody outside it. */
export type ChosenPerson = { userId: string } | { name: string; email: string };

type People = { customer: { name: string; email: string | null }; staff?: Record<string, { name: string; email: string | null }> };

/**
 * Every step on THIS record's path that still has nobody in it.
 *
 * "Choose at send", a role and an unfilled email were all drawable, and none of
 * them was ever asked for: the document went out to a recipient called "To be
 * chosen" with no address, or parked on an approval nobody could be emailed.
 *
 * Walked the way the runtime walks it — conditions already decided, since the
 * record's figures are frozen when it is sent — and down BOTH edges of an
 * approval, because the "rejected" branch can end in a step that needs a person
 * too, and finding that out after a rejection is finding it out too late.
 */
export function workflowAsks(graph: WorkflowGraph, opts: People & { vars: WorkflowContext }): WorkflowAsk[] {
  const staff = opts.staff ?? {};
  const asks: WorkflowAsk[] = [];
  const seen = new Set<string>();
  const queue: Array<string | undefined> = [graph.start];
  while (queue.length > 0 && seen.size < 200) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = graph.nodes[id];
    if (!node || node.type === "end") continue;
    if (node.type === "start") { queue.push(node.next); continue; }
    if (node.type === "condition") { queue.push(evalCondition(node, opts.vars) ? node.whenTrue : node.whenFalse); continue; }

    // The same answer compileWorkflow gets: a member of staff who is still on
    // the team, the owner and the customer need nobody named; a role, a blank
    // email, "choose at send" and someone who has since left all do.
    if (resolveWho(node.who, { customer: opts.customer, staff }).needsInput) {
      asks.push({
        nodeId: node.id,
        label: node.label || (node.type === "approval" ? "Approval" : "Signer"),
        kind: node.type === "approval" ? "approver" : "signer",
        hint: node.who.mode === "role" ? node.who.role ?? null : null,
      });
    }
    if (node.type === "approval") queue.push(node.whenApproved, node.whenRejected);
    else queue.push(node.next);
  }
  return asks;
}

/**
 * The graph with the sender's choices written into the steps they were asked
 * about. Returns a copy: the saved workflow is a design, and one send's people
 * must not become everybody's.
 */
export function applyChosen(graph: WorkflowGraph, chosen: Record<string, ChosenPerson>): WorkflowGraph {
  const nodes = { ...graph.nodes };
  for (const [nodeId, person] of Object.entries(chosen)) {
    const node = nodes[nodeId];
    if (!node || (node.type !== "signer" && node.type !== "approval")) continue;
    const who: SignerWho = "userId" in person
      ? { mode: "staff", userId: person.userId }
      : { mode: "email", name: person.name, email: person.email };
    nodes[nodeId] = { ...node, who };
  }
  return { ...graph, nodes };
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
    if (node.type === "approval") {
      // Only signature-mode approvals need a doc block + recipient; decision
      // approvals are runtime gates. Follow the happy (approved) path for layout.
      if (node.mode === "signature") {
        const r = resolveWho(node.who, { customer: opts.customer, staff });
        signers.push({ nodeId: node.id, label: node.label || r.name, role: "approver", mode: node.who.mode, name: r.name, email: r.email, needsInput: r.needsInput, roleHint: r.roleHint });
      }
      cur = node.whenApproved;
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
