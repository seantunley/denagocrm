import type { FlowNode } from "./flow";
import { nodeLabel } from "./flowVersionDiff";

/**
 * FIND ON THE CANVAS (Node-RED's search; Sean, 2026-11-04): "brochure" finds every step that mentions it — in its
 * message, buttons, captions, variable names, URLs and the rest of what the owner typed. Wiring (`next`, targets,
 * ids) is not text anyone typed, so it is never matched.
 */
export type FlowSearchHit = { nodeId: string; label: string; snippet: string };

const WIRING = /^(id|type|next|target|.*Next|.*Id)$/;

/** Every piece of text the owner typed into a step, nested ones (button labels, switch cases) included. */
function typedText(value: unknown, key = ""): string[] {
  if (typeof value === "string") return WIRING.test(key) ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => typedText(item, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => typedText(v, k));
  return [];
}

export function searchFlow(nodes: Record<string, FlowNode>, query: string, limit = 25): FlowSearchHit[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const hits: FlowSearchHit[] = [];
  for (const node of Object.values(nodes)) {
    const label = nodeLabel(node, node.id);
    const found = [label, ...typedText(node)].find((text) => text.toLocaleLowerCase().includes(q));
    if (!found) continue;
    const at = found.toLocaleLowerCase().indexOf(q);
    const start = Math.max(0, at - 24);
    hits.push({ nodeId: node.id, label, snippet: `${start ? "…" : ""}${found.slice(start, at + q.length + 40).replace(/\s+/g, " ")}${at + q.length + 40 < found.length ? "…" : ""}` });
    if (hits.length >= limit) break;
  }
  return hits;
}
