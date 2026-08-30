import "server-only";
import crypto from "crypto";
import type { Flow } from "./flow";

type ProposalPayload = {
  flowId: string;
  ownerId: string;
  baseHash: string;
  definition: string;
  instruction: string;
  expiresAt: number;
};

export type FlowProposalDiff = {
  added: string[];
  removed: string[];
  changed: string[];
  startChanged: boolean;
};

const proposalSecret = (): string => {
  const secret = process.env.SESSION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("SESSION_SECRET is not set — AI flow proposals cannot be signed.");
  return "local-development-flow-proposal-secret";
};

export const flowDefinitionHash = (definition: string): string => crypto.createHash("sha256").update(definition).digest("hex");

const mac = (encoded: string): string => crypto.createHmac("sha256", proposalSecret()).update(`flow-ai-proposal:${encoded}`).digest("base64url");

export function signFlowProposal(input: Omit<ProposalPayload, "expiresAt">, now = Date.now()): { token: string; expiresAt: string } {
  const payload: ProposalPayload = { ...input, expiresAt: now + 15 * 60_000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${mac(encoded)}`, expiresAt: new Date(payload.expiresAt).toISOString() };
}

export function verifyFlowProposal(token: string, now = Date.now()): ProposalPayload | null {
  if (!token || token.length > 300_000) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, supplied] = parts;
  if (!encoded || !supplied) return null;
  const expected = mac(encoded);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ProposalPayload;
    if (
      typeof payload.flowId !== "string" || !payload.flowId ||
      typeof payload.ownerId !== "string" || !payload.ownerId ||
      typeof payload.baseHash !== "string" || !payload.baseHash ||
      typeof payload.definition !== "string" || !payload.definition ||
      typeof payload.instruction !== "string" || !payload.instruction ||
      typeof payload.expiresAt !== "number" || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function parse(definition: string): Flow | null {
  try {
    const flow = JSON.parse(definition) as Flow;
    return flow?.start && flow?.nodes ? flow : null;
  } catch {
    return null;
  }
}

export function diffFlowDefinitions(beforeDefinition: string, afterDefinition: string): FlowProposalDiff {
  const before = parse(beforeDefinition);
  const after = parse(afterDefinition);
  if (!before || !after) return { added: [], removed: [], changed: [], startChanged: false };
  const beforeIds = new Set(Object.keys(before.nodes));
  const afterIds = new Set(Object.keys(after.nodes));
  const added = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const changed = [...beforeIds].filter((id) => afterIds.has(id) && JSON.stringify(before.nodes[id]) !== JSON.stringify(after.nodes[id])).sort();
  return { added, removed, changed, startChanged: before.start !== after.start };
}
