import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId, type TenantWriteTx } from "./tenantWrite";
import { logError } from "./errorLog";

export type BotFlowEventType =
  | "flow_started"
  | "node_waiting"
  | "choice_selected"
  | "capture_submitted"
  | "slot_selected"
  | "crm_action"
  | "flow_handoff"
  | "flow_completed"
  | "delivery_failed";

export type BotFlowEventInput = {
  channel: string;
  conversationKey: string;
  flowVersionId?: string | null;
  nodeId?: string | null;
  eventType: BotFlowEventType;
  metadata?: Record<string, string | number | boolean | null>;
};

export type BotFlowNodeAnalytics = {
  nodeId: string;
  reached: number;
  interacted: number;
  crmActions: number;
  handoffs: number;
  deliveryFailures: number;
};

export type BotFlowVersionAnalytics = {
  started: number;
  completed: number;
  handedOff: number;
  deliveryFailures: number;
  nodes: BotFlowNodeAnalytics[];
};

function safeMetadata(metadata: BotFlowEventInput["metadata"]): string | null {
  if (!metadata || !Object.keys(metadata).length) return null;
  const encoded = JSON.stringify(metadata);
  // Analytics metadata is diagnostic context, never a transcript/content store.
  // Refuse oversized payloads rather than silently building a second message DB.
  return encoded.length <= 4000 ? encoded : JSON.stringify({ truncated: true });
}

/**
 * Insert execution events inside an existing tenant write transaction. Runtime
 * integration can therefore commit the flow position/outbox and its analytics
 * marker together without needing a Prisma model for this append-only ledger.
 */
export async function recordBotFlowEventsTx(
  tx: TenantWriteTx,
  tenantId: string,
  events: BotFlowEventInput[],
): Promise<void> {
  for (const event of events) {
    if (!event.channel || !event.conversationKey) continue;
    await tx.$executeRawUnsafe(
      `INSERT INTO "BotFlowEvent"
        ("id", "tenantId", "channel", "conversationKey", "flowVersionId", "nodeId", "eventType", "metadata", "occurredAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CURRENT_TIMESTAMP)`,
      crypto.randomUUID(),
      tenantId,
      event.channel.slice(0, 40),
      event.conversationKey.slice(0, 220),
      event.flowVersionId ?? null,
      event.nodeId?.slice(0, 220) ?? null,
      event.eventType,
      safeMetadata(event.metadata),
    );
  }
}

/**
 * Best-effort standalone recorder for events that happen outside the main flow
 * transaction (for example a provider delivery failure discovered later).
 * Analytics must never turn a successful customer action into a failed webhook.
 */
export async function recordBotFlowEvents(events: BotFlowEventInput[]): Promise<void> {
  try {
    const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      await recordBotFlowEventsTx(tx as TenantWriteTx, tenantId, events);
    });
  } catch (error) {
    await logError("bot-flow-analytics", error).catch(() => {});
  }
}

type SummaryRow = {
  started: bigint | number;
  completed: bigint | number;
  handedOff: bigint | number;
  deliveryFailures: bigint | number;
};

type NodeRow = {
  nodeId: string | null;
  reached: bigint | number;
  interacted: bigint | number;
  crmActions: bigint | number;
  handoffs: bigint | number;
  deliveryFailures: bigint | number;
};

const n = (value: bigint | number | null | undefined) => Number(value ?? 0);

/**
 * Aggregate only explicit tenant + published-version ids. `basePrisma` bypasses
 * RLS for trusted reporting, so the tenant predicate is mandatory and is never
 * inferred from a caller-supplied id alone.
 */
export async function getBotFlowVersionAnalytics(
  flowVersionIds: string[],
): Promise<BotFlowVersionAnalytics> {
  if (!flowVersionIds.length) {
    return { started: 0, completed: 0, handedOff: 0, deliveryFailures: 0, nodes: [] };
  }
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const summaryRows = await basePrisma.$queryRaw<SummaryRow[]>(Prisma.sql`
    SELECT
      COUNT(*) FILTER (WHERE "eventType" = 'flow_started') AS "started",
      COUNT(*) FILTER (WHERE "eventType" = 'flow_completed') AS "completed",
      COUNT(*) FILTER (WHERE "eventType" = 'flow_handoff') AS "handedOff",
      COUNT(*) FILTER (WHERE "eventType" = 'delivery_failed') AS "deliveryFailures"
    FROM "BotFlowEvent"
    WHERE "tenantId" = ${tenantId}
      AND "flowVersionId" IN (${Prisma.join(flowVersionIds)})
  `);
  const nodeRows = await basePrisma.$queryRaw<NodeRow[]>(Prisma.sql`
    SELECT
      "nodeId",
      COUNT(*) FILTER (WHERE "eventType" = 'node_waiting') AS "reached",
      COUNT(*) FILTER (WHERE "eventType" IN ('choice_selected', 'capture_submitted', 'slot_selected')) AS "interacted",
      COUNT(*) FILTER (WHERE "eventType" = 'crm_action') AS "crmActions",
      COUNT(*) FILTER (WHERE "eventType" = 'flow_handoff') AS "handoffs",
      COUNT(*) FILTER (WHERE "eventType" = 'delivery_failed') AS "deliveryFailures"
    FROM "BotFlowEvent"
    WHERE "tenantId" = ${tenantId}
      AND "flowVersionId" IN (${Prisma.join(flowVersionIds)})
      AND "nodeId" IS NOT NULL
    GROUP BY "nodeId"
    ORDER BY COUNT(*) FILTER (WHERE "eventType" = 'node_waiting') DESC
  `);
  const summary = summaryRows[0];
  return {
    started: n(summary?.started),
    completed: n(summary?.completed),
    handedOff: n(summary?.handedOff),
    deliveryFailures: n(summary?.deliveryFailures),
    nodes: nodeRows.flatMap((row) => row.nodeId ? [{
      nodeId: row.nodeId,
      reached: n(row.reached),
      interacted: n(row.interacted),
      crmActions: n(row.crmActions),
      handoffs: n(row.handoffs),
      deliveryFailures: n(row.deliveryFailures),
    }] : []),
  };
}
