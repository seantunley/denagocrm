import "server-only";
import crypto from "crypto";
import { getSetting } from "./settings";
import type { FlowSnippet } from "./flowSnippetDefinition";

export { insertFlowSnippet } from "./flowSnippetDefinition";
export type { FlowSnippet } from "./flowSnippetDefinition";

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

