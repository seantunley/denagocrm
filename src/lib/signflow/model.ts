/**
 * Signing-workflow model — a visual graph of signer + condition nodes that
 * compiles (against a quote / job card) into the signing hub's ordered recipient
 * chain. Deliberately separate from the chatbot flow; it reuses the same visual
 * language (React Flow) but its own node vocabulary.
 */
import { z } from "zod";

// ── who a signer step resolves to ───────────────────────────────────
export const SIGNER_MODES = ["staff", "role", "owner", "customer", "email", "ask"] as const;
export type SignerMode = (typeof SIGNER_MODES)[number];

// ── condition fields the rules can test ─────────────────────────────
export const CONDITION_FIELDS = ["total", "discount", "segment", "product"] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const CONDITION_OPS = ["gt", "gte", "lt", "lte", "eq", "neq", "contains"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

const whoSchema = z.object({
  mode: z.enum(SIGNER_MODES),
  userId: z.string().optional(),   // staff
  role: z.string().optional(),     // role (e.g. "manager", "finance")
  email: z.string().optional(),    // fixed email
  name: z.string().optional(),     // display / fixed name
});
export type SignerWho = z.infer<typeof whoSchema>;

const startNode = z.object({ id: z.string(), type: z.literal("start"), next: z.string().optional() });
const signerNode = z.object({
  id: z.string(),
  type: z.literal("signer"),
  label: z.string().default(""),
  who: whoSchema,
  role: z.enum(["signer", "approver"]).default("signer"),
  next: z.string().optional(),
});
const conditionNode = z.object({
  id: z.string(),
  type: z.literal("condition"),
  field: z.enum(CONDITION_FIELDS),
  op: z.enum(CONDITION_OPS),
  value: z.string().default(""),
  whenTrue: z.string().optional(),
  whenFalse: z.string().optional(),
});
// Internal approval gate: a CRM person approves/rejects before the flow proceeds.
// mode "decision" = approve/reject only (no ink); "signature" = they sign the doc
// as an approver. Rejection follows whenRejected (draw your own rejected branch).
const approvalNode = z.object({
  id: z.string(),
  type: z.literal("approval"),
  label: z.string().default(""),
  mode: z.enum(["decision", "signature"]).default("decision"),
  who: whoSchema,
  whenApproved: z.string().optional(),
  whenRejected: z.string().optional(),
});
const endNode = z.object({ id: z.string(), type: z.literal("end") });

export const signNodeSchema = z.discriminatedUnion("type", [startNode, signerNode, conditionNode, approvalNode, endNode]);
export type SignNode = z.infer<typeof signNodeSchema>;
export type SignerNode = z.infer<typeof signerNode>;
export type ConditionNode = z.infer<typeof conditionNode>;
export type ApprovalNode = z.infer<typeof approvalNode>;

export const workflowGraphSchema = z.object({
  start: z.string(),
  nodes: z.record(z.string(), signNodeSchema),
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

export function parseGraph(data: unknown): WorkflowGraph | null {
  const r = workflowGraphSchema.safeParse(data);
  return r.success ? r.data : null;
}

let seq = 0;
export function nid(type: string): string {
  // deterministic-enough unique id for client use (Date.now varies per session)
  return `${type}_${Math.abs((Date.now() ^ (seq++ << 16))).toString(36)}`;
}

/** A fresh workflow: Denago rep → customer, sequential (mirrors the built-in default). */
export function blankWorkflow(): WorkflowGraph {
  const start = "start_0";
  const denago = nid("signer");
  const customer = nid("signer");
  const end = "end_0";
  return {
    start,
    nodes: {
      [start]: { id: start, type: "start", next: denago },
      [denago]: { id: denago, type: "signer", label: "Denago", who: { mode: "staff" }, role: "approver", next: customer },
      [customer]: { id: customer, type: "signer", label: "Customer", who: { mode: "customer" }, role: "signer", next: end },
      [end]: { id: end, type: "end" },
    },
    positions: {
      [start]: { x: 40, y: 40 }, [denago]: { x: 320, y: 40 }, [customer]: { x: 600, y: 40 }, [end]: { x: 880, y: 40 },
    },
  };
}

export const CONDITION_LABEL: Record<ConditionField, string> = {
  total: "Quote total (R)", discount: "Discount %", segment: "Customer segment", product: "Product / model",
};
export const OP_LABEL: Record<ConditionOp, string> = {
  gt: ">", gte: "≥", lt: "<", lte: "≤", eq: "=", neq: "≠", contains: "contains",
};
