/**
 * Industry lifecycles (brief §5): what a workspace calls each step of a deal, and
 * which steps it has. Pure — the server reader is dealLifecycleServer.ts.
 *
 * Each template maps its steps onto the facts the CRM actually records (accepted,
 * deposit, stock allocation, PDI, delivery). A step a business has but the CRM
 * does not record (a law firm's "compliance", a wholesaler's "packing") is left
 * OFF the journey rather than pinned to an unrelated check. Automotive is the
 * default, so every existing workspace keeps exactly what it had.
 */
import { AUTOMOTIVE_LIFECYCLE, type Lifecycle, type MilestoneKey } from "./dealMilestones";

export const DEAL_LIFECYCLE_KEY = "DEAL_LIFECYCLE";

export const LIFECYCLE_TEMPLATES = {
  automotive: { name: "Automotive", detail: "Quote → Accepted → Deposit → Stock → PDI → Delivery", lifecycle: AUTOMOTIVE_LIFECYCLE },
  services: {
    name: "Professional services",
    detail: "Proposal → Engagement → Retainer → Completion. No stock or inspection steps.",
    lifecycle: {
      labels: { quote: "Proposal", accepted: "Engagement", deposit: "Retainer", stock: "Stock", pdi: "PDI", delivery: "Completion" },
      steps: ["quote", "accepted", "deposit", "delivery"],
    },
  },
  wholesale: {
    name: "Wholesale",
    detail: "Quote → Order confirmed → Payment → Stock → Dispatch. No inspection step.",
    lifecycle: {
      labels: { quote: "Quote", accepted: "Order confirmed", deposit: "Payment", stock: "Stock", pdi: "PDI", delivery: "Dispatch" },
      steps: ["quote", "accepted", "deposit", "stock", "delivery"],
    },
  },
  property: {
    name: "Property",
    detail: "Offer → Offer accepted → Deposit → Handover. No stock or inspection steps.",
    lifecycle: {
      labels: { quote: "Offer", accepted: "Offer accepted", deposit: "Deposit", stock: "Stock", pdi: "PDI", delivery: "Handover" },
      steps: ["quote", "accepted", "deposit", "delivery"],
    },
  },
} as const satisfies Record<string, { name: string; detail: string; lifecycle: Lifecycle }>;
export type LifecycleTemplate = keyof typeof LIFECYCLE_TEMPLATES;

export const lifecycleTemplate = (value: string | null | undefined): LifecycleTemplate =>
  value && value in LIFECYCLE_TEMPLATES ? (value as LifecycleTemplate) : "automotive";

/**
 * The lifecycle in force: the template's steps, less any whose module is off —
 * stock needs Stock & inventory, PDI needs Automotive. A switched-off module never
 * asks for a step nobody can do (§5: "disabled modules do not generate impossible actions").
 */
export function lifecycleFor(template: LifecycleTemplate, enabledModules: ReadonlySet<string>): Lifecycle {
  const base = LIFECYCLE_TEMPLATES[template].lifecycle;
  const needs: Partial<Record<MilestoneKey, string>> = { stock: "commerce", pdi: "automotive" };
  return { labels: base.labels, steps: base.steps.filter((step) => !needs[step] || enabledModules.has(needs[step]!)) };
}
