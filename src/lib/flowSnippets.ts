import "server-only";
import crypto from "crypto";
import { getSetting } from "./settings";
import type { Flow, FlowNode } from "./flow";

export type FlowSnippet = {
  id: string;
  name: string;
  description?: string;
  definition: Flow & { positions?: Record<string, { x: number; y: number }> };
  createdAt: string;
  updatedAt: string;
};

export const FLOW_SNIPPETS_SETTING = "BOT_FLOW_SNIPPETS";

function validDefinition(value: unknown): value is FlowSnippet["definition"] {
  if (!value || typeof value !== "object") return false;
  const flow = value as { start?: unknown; nodes?: unknown };
  return typeof flow.start === "string" && Boolean(flow.nodes) && typeof flow.nodes === "object";
}

export async function getFlowSnippets(): Promise<FlowSnippet[]> {
  const raw = await getSetting(FLOW_SNIPPETS_SETTING);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      if (typeof value.id !== "string" || typeof value.name !== "string" || !validDefinition(value.definition)) return [];
      const createdAt = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
      const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : createdAt;
      return [{
        id: value.id.slice(0, 120),
        name: value.name.trim().slice(0, 180),
        description: typeof value.description === "string" ? value.description.trim().slice(0, 500) || undefined : undefined,
        definition: value.definition,
        createdAt,
        updatedAt,
      } satisfies FlowSnippet];
    });
  } catch {
    return [];
  }
}

export function newFlowSnippet(input: {
  name: string;
  description?: string;
  definition: FlowSnippet["definition"];
}): FlowSnippet {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: input.name.trim().slice(0, 180),
    description: input.description?.trim().slice(0, 500) || undefined,
    definition: JSON.parse(JSON.stringify(input.definition)) as FlowSnippet["definition"],
    createdAt: now,
    updatedAt: now,
  };
}

function remapNode(node: FlowNode, idMap: Map<string, string>): FlowNode {
  const next = (id?: string) => id ? idMap.get(id) : undefined;
  const id = idMap.get(node.id)!;
  if (node.type === "choice") {
    return { ...node, id, options: node.options.map((option) => ({ ...option, next: next(option.next) })) };
  }
  if (node.type === "condition") {
    return { ...node, id, trueNext: next(node.trueNext), falseNext: next(node.falseNext) };
  }
  if (node.type === "ai") return { ...node, id, handoffNext: next(node.handoffNext) };
  if (node.type === "handoff" || node.type === "end") return { ...node, id };
  return { ...node, id, next: next(node.next) } as FlowNode;
}

/**
 * Flatten a reusable block into a target DRAFT. The inserted copy has new node
 * ids and no runtime reference back to the source snippet. That means later
 * edits/deletes of the snippet cannot change a published or in-progress flow.
 */
export function insertFlowSnippet(
  target: FlowSnippet["definition"],
  snippet: FlowSnippet["definition"],
  prefix = `blk_${crypto.randomBytes(4).toString("hex")}`,
): { definition: FlowSnippet["definition"]; insertedStart: string; insertedNodeIds: string[] } {
  const cleanPrefix = prefix.replace(/\W/g, "_").slice(0, 40) || "block";
  const idMap = new Map<string, string>();
  const existing = new Set(Object.keys(target.nodes));
  for (const oldId of Object.keys(snippet.nodes)) {
    let candidate = `${cleanPrefix}_${oldId}`.replace(/\W/g, "_").slice(0, 160);
    let suffix = 1;
    while (existing.has(candidate) || [...idMap.values()].includes(candidate)) {
      candidate = `${cleanPrefix}_${oldId}_${suffix++}`.replace(/\W/g, "_").slice(0, 160);
    }
    idMap.set(oldId, candidate);
  }

  const nodes: Record<string, FlowNode> = { ...target.nodes };
  for (const node of Object.values(snippet.nodes)) {
    const remapped = remapNode(node, idMap);
    nodes[remapped.id] = remapped;
  }

  const targetPositions = { ...(target.positions ?? {}) };
  const sourcePositions = snippet.positions ?? {};
  const targetXs = Object.values(targetPositions).map((position) => position.x);
  const offsetX = (targetXs.length ? Math.max(...targetXs) : 0) + 340;
  let index = 0;
  for (const oldId of Object.keys(snippet.nodes)) {
    const newId = idMap.get(oldId)!;
    const source = sourcePositions[oldId] ?? { x: (index % 3) * 280, y: Math.floor(index / 3) * 200 };
    targetPositions[newId] = { x: source.x + offsetX, y: source.y + 40 };
    index += 1;
  }

  return {
    definition: { start: target.start, nodes, positions: targetPositions },
    insertedStart: idMap.get(snippet.start)!,
    insertedNodeIds: [...idMap.values()],
  };
}
