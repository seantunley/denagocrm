import { isAnnotation, type Flow, type FlowNode } from "./flow";

/**
 * TIDY LAYOUT (Node-RED's arrange; Sean, 2026-11-04): one button lines the steps up — the start on the left, each
 * step one column right of the first step that leads to it, in the order the conversation reaches them; steps
 * nothing leads to go in a last column. Notes and groups are the owner's own framing, so they stay where they are.
 */
export const TIDY_COLUMN = 330;
export const TIDY_ROW = 210;

/** Where a step can go next, in the order it shows them (buttons top to bottom). */
export function nextSteps(node: FlowNode): string[] {
  const n = node as Record<string, unknown>;
  const out: unknown[] = [];
  if (node.type === "choice") out.push(...node.options.map((o) => o.next));
  if (node.type === "switch") out.push(...node.cases.map((c) => c.next));
  if (node.type === "goto") out.push(node.target);
  out.push(n.next, n.trueNext, n.falseNext, n.openNext, n.closedNext, n.defaultNext, n.handoffNext, n.unavailableNext, n.failureNext);
  return [...new Set(out.filter((id): id is string => typeof id === "string" && id !== ""))];
}

export function tidyPositions(flow: Flow, origin = { x: 40, y: 40 }): Record<string, { x: number; y: number }> {
  const column = new Map<string, number>();
  const order: string[] = [];
  const queue = flow.nodes[flow.start] ? [flow.start] : [];
  if (queue.length) column.set(flow.start, 0);
  // Breadth-first: a step sits one column right of the FIRST step that reaches it, so loops back to the menu
  // don't drag the menu to the right.
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of nextSteps(flow.nodes[id])) {
      if (column.has(next) || !flow.nodes[next] || isAnnotation(flow.nodes[next])) continue;
      column.set(next, column.get(id)! + 1);
      queue.push(next);
    }
  }
  const lastColumn = Math.max(-1, ...column.values()) + 1;
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (!column.has(id) && !isAnnotation(node)) { column.set(id, lastColumn); order.push(id); }
  }
  const rows = new Map<number, number>();
  const positions: Record<string, { x: number; y: number }> = {};
  for (const id of order) {
    const col = column.get(id)!;
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    positions[id] = { x: origin.x + col * TIDY_COLUMN, y: origin.y + row * TIDY_ROW };
  }
  return positions;
}
