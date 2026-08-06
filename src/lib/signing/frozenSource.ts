import "server-only";
import crypto from "crypto";
import type { RenderCtx } from "@/lib/doceditor/serialize";
import { bindCtx } from "./render";

/**
 * Capture the exact merge context that was used when the envelope was prepared.
 * Completion must render from this frozen value and never re-read a mutable quote,
 * job card, contact, company profile or pricing row.
 */
export async function captureFrozenSourceContext(
  quoteId: string | null | undefined,
  jobCardId: string | null | undefined,
): Promise<Record<string, unknown>> {
  const context = await bindCtx(quoteId ?? null, jobCardId ?? null);
  return cloneJson(context) as Record<string, unknown>;
}

/** Deterministic JSON representation used for source/workflow evidence hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function cloneJson(value: RenderCtx | unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}
