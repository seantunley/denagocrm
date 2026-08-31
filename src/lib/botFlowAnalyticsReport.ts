import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { getBotFlowVersionAnalytics, type BotFlowVersionAnalytics } from "./botFlowAnalytics";
import {
  normalizeBotAnalyticsFilters,
  type BotAnalyticsFilterInput,
  type BotAnalyticsFilters,
} from "./botFlowAnalyticsFilters";
import type { Flow, FlowNode } from "./flow";

export type FlowVersionReportMeta = { id: string; version: number; publishedAt: Date };
export type FlowChannelAnalytics = {
  channel: string;
  conversations: number;
  completed: number;
  handedOff: number;
  crmActions: number;
};
export type FlowNodeReport = {
  nodeId: string;
  type: string;
  label: string;
  reached: number;
  interacted: number | null;
  progressionRate: number | null;
  dropOff: number | null;
  crmActions: number;
  handoffs: number;
  deliveryFailures: number;
};
export type FlowTrendPoint = { day: string; started: number; completed: number; handedOff: number; crmActions: number };
export type FlowActionAnalytics = { action: string; label: string; count: number };
export type FlowVersionPerformance = FlowVersionReportMeta & {
  started: number;
  completed: number;
  handedOff: number;
  crmActions: number;
  deliveryFailures: number;
};
export type BotFlowAnalyticsReport = {
  versions: FlowVersionReportMeta[];
  selectedVersion: FlowVersionReportMeta | null;
  filters: BotAnalyticsFilters;
  summary: BotFlowVersionAnalytics;
  allTime: BotFlowVersionAnalytics;
  channels: FlowChannelAnalytics[];
  nodes: FlowNodeReport[];
  trend: FlowTrendPoint[];
  actions: FlowActionAnalytics[];
  versionPerformance: FlowVersionPerformance[];
};

type VersionRow = { id: string; version: number; createdAt: Date; definition: string };
type ChannelRow = {
  channel: string;
  conversations: bigint | number;
  completed: bigint | number;
  handedOff: bigint | number;
  crmActions: bigint | number;
};
type TrendRow = {
  day: Date | string;
  started: bigint | number;
  completed: bigint | number;
  handedOff: bigint | number;
  crmActions: bigint | number;
};
type ActionRow = { action: string; count: bigint | number };
type VersionPerformanceRow = {
  id: string;
  version: number;
  createdAt: Date;
  started: bigint | number;
  completed: bigint | number;
  handedOff: bigint | number;
  crmActions: bigint | number;
  deliveryFailures: bigint | number;
};

const n = (value: bigint | number | null | undefined) => Number(value ?? 0);

function nodeLabel(node: FlowNode | undefined, nodeId: string): string {
  if (!node) return nodeId;
  if (node.type === "message" || node.type === "handoff") return node.text?.trim().slice(0, 70) || nodeId;
  if (node.type === "choice" || node.type === "capture" || node.type === "captureFile" || node.type === "slots") return node.text.trim().slice(0, 70) || nodeId;
  if (node.type === "answer") return node.answerSource ? `Answer: ${node.answerSource}` : node.text?.trim().slice(0, 70) || nodeId;
  if (node.type === "booking") return `CRM action: ${node.action ?? "service"}`;
  if (node.type === "journey") return `Journey: ${node.journeyId}`;
  if (node.type === "condition") return `Condition: ${node.condition.variable} ${node.condition.operator}`;
  if (node.type === "image") return node.caption?.trim().slice(0, 70) || "Image";
  if (node.type === "ai") return "AI conversation";
  return "End";
}

function isInteractive(node: FlowNode | undefined): boolean {
  return node?.type === "choice" || node?.type === "capture" || node?.type === "captureFile" || node?.type === "slots";
}

function parseFlow(definition: string | undefined): Flow | null {
  if (!definition) return null;
  try {
    const parsed = JSON.parse(definition);
    return parsed?.start && parsed?.nodes ? parsed as Flow : null;
  } catch {
    return null;
  }
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    booking_service: "Service requests created",
    booking_demo: "Demo / test-drive leads created",
    booking_lead: "Leads created",
    booking_lookup: "Bookings found",
    booking_cancel: "Bookings cancelled",
    book: "Workshop slots booked",
    reschedule: "Workshop slots rescheduled",
    journey_start: "Journey enrolments",
  };
  return labels[action] ?? action.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function dayKey(value: Date | string): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(value).toISOString().slice(0, 10);
}

function fillTrend(rows: TrendRow[], filters: BotAnalyticsFilters): FlowTrendPoint[] {
  const byDay = new Map(rows.map((row) => [dayKey(row.day), row]));
  return Array.from({ length: filters.rangeDays }, (_, index) => {
    const day = new Date(filters.occurredFrom.getTime() + 2 * 60 * 60 * 1000);
    day.setUTCDate(day.getUTCDate() + index);
    const key = day.toISOString().slice(0, 10);
    const row = byDay.get(key);
    return {
      day: key,
      started: n(row?.started),
      completed: n(row?.completed),
      handedOff: n(row?.handedOff),
      crmActions: n(row?.crmActions),
    };
  });
}

/**
 * Reporting is pinned to immutable published versions. The mutable draft is not
 * used to label historic nodes, so editing today's canvas cannot rewrite the
 * meaning of yesterday's funnel.
 */
export async function getBotFlowAnalyticsReport(
  flowId: string,
  input: BotAnalyticsFilterInput = {},
): Promise<BotFlowAnalyticsReport> {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const versionRows = await basePrisma.$queryRaw<VersionRow[]>(Prisma.sql`
    SELECT "id", "version", "createdAt", "definition"
      FROM "BotFlowVersion"
     WHERE "tenantId" = ${tenantId}
       AND "flowId" = ${flowId}
     ORDER BY "version" DESC
  `);
  const versions = versionRows.map((row) => ({ id: row.id, version: Number(row.version), publishedAt: row.createdAt }));
  const filters = normalizeBotAnalyticsFilters(input, versions.map((version) => version.id));
  const selectedVersion = versions.find((version) => version.id === filters.versionId) ?? null;
  const selectedRow = versionRows.find((row) => row.id === filters.versionId);
  const versionIds = versions.map((version) => version.id);

  if (versionIds.length === 0) {
    const empty = { started: 0, completed: 0, handedOff: 0, deliveryFailures: 0, nodes: [] };
    return { versions, selectedVersion: null, filters, summary: empty, allTime: empty, channels: [], nodes: [], trend: [], actions: [], versionPerformance: [] };
  }

  const occurredFilter = Prisma.sql`AND "occurredAt" >= ${filters.occurredFrom}`;
  const channelFilter = filters.channel ? Prisma.sql`AND "channel" = ${filters.channel}` : Prisma.empty;
  const joinedOccurredFilter = Prisma.sql`AND e."occurredAt" >= ${filters.occurredFrom}`;
  const joinedChannelFilter = filters.channel ? Prisma.sql`AND e."channel" = ${filters.channel}` : Prisma.empty;
  const selectedVersionIds = selectedVersion ? [selectedVersion.id] : versionIds;
  const selectedVersionsSql = Prisma.join(selectedVersionIds);

  const [summary, allTime, channels, trendRows, actionRows, versionRowsPerformance] = await Promise.all([
    getBotFlowVersionAnalytics(selectedVersionIds, { occurredFrom: filters.occurredFrom, channel: filters.channel }),
    getBotFlowVersionAnalytics(versionIds),
    basePrisma.$queryRaw<ChannelRow[]>(Prisma.sql`
      SELECT
        "channel",
        COUNT(*) FILTER (WHERE "eventType" = 'flow_started') AS "conversations",
        COUNT(*) FILTER (WHERE "eventType" = 'flow_completed') AS "completed",
        COUNT(*) FILTER (WHERE "eventType" = 'flow_handoff') AS "handedOff",
        COUNT(*) FILTER (WHERE "eventType" = 'crm_action') AS "crmActions"
      FROM "BotFlowEvent"
      WHERE "tenantId" = ${tenantId}
        AND "flowVersionId" IN (${selectedVersionsSql})
        ${occurredFilter}
        ${channelFilter}
      GROUP BY "channel"
      ORDER BY COUNT(*) FILTER (WHERE "eventType" = 'flow_started') DESC
    `),
    basePrisma.$queryRaw<TrendRow[]>(Prisma.sql`
      SELECT
        to_char(date_trunc('day', "occurredAt" + INTERVAL '2 hours'), 'YYYY-MM-DD') AS "day",
        COUNT(*) FILTER (WHERE "eventType" = 'flow_started') AS "started",
        COUNT(*) FILTER (WHERE "eventType" = 'flow_completed') AS "completed",
        COUNT(*) FILTER (WHERE "eventType" = 'flow_handoff') AS "handedOff",
        COUNT(*) FILTER (WHERE "eventType" = 'crm_action') AS "crmActions"
      FROM "BotFlowEvent"
      WHERE "tenantId" = ${tenantId}
        AND "flowVersionId" IN (${selectedVersionsSql})
        ${occurredFilter}
        ${channelFilter}
      GROUP BY date_trunc('day', "occurredAt" + INTERVAL '2 hours')
      ORDER BY "day"
    `),
    basePrisma.$queryRaw<ActionRow[]>(Prisma.sql`
      SELECT COALESCE("metadata" ->> 'action', 'other') AS "action", COUNT(*) AS "count"
      FROM "BotFlowEvent"
      WHERE "tenantId" = ${tenantId}
        AND "flowVersionId" IN (${selectedVersionsSql})
        AND "eventType" = 'crm_action'
        ${occurredFilter}
        ${channelFilter}
      GROUP BY COALESCE("metadata" ->> 'action', 'other')
      ORDER BY COUNT(*) DESC, "action"
    `),
    basePrisma.$queryRaw<VersionPerformanceRow[]>(Prisma.sql`
      SELECT
        v."id",
        v."version",
        v."createdAt",
        COUNT(e."id") FILTER (WHERE e."eventType" = 'flow_started') AS "started",
        COUNT(e."id") FILTER (WHERE e."eventType" = 'flow_completed') AS "completed",
        COUNT(e."id") FILTER (WHERE e."eventType" = 'flow_handoff') AS "handedOff",
        COUNT(e."id") FILTER (WHERE e."eventType" = 'crm_action') AS "crmActions",
        COUNT(e."id") FILTER (WHERE e."eventType" = 'delivery_failed') AS "deliveryFailures"
      FROM "BotFlowVersion" v
      LEFT JOIN "BotFlowEvent" e
        ON e."flowVersionId" = v."id"
       AND e."tenantId" = ${tenantId}
       ${joinedOccurredFilter}
       ${joinedChannelFilter}
      WHERE v."tenantId" = ${tenantId}
        AND v."flowId" = ${flowId}
      GROUP BY v."id", v."version", v."createdAt"
      ORDER BY v."version" DESC
    `),
  ]);

  const selectedFlow = parseFlow(selectedRow?.definition);
  const selectedByNode = new Map(summary.nodes.map((item) => [item.nodeId, item]));
  const nodeIds = new Set<string>([
    ...Object.keys(selectedFlow?.nodes ?? {}),
    ...summary.nodes.map((item) => item.nodeId),
  ]);
  const nodes: FlowNodeReport[] = [...nodeIds].map((nodeId) => {
    const node = selectedFlow?.nodes[nodeId];
    const stats = selectedByNode.get(nodeId);
    const reached = stats?.reached ?? 0;
    const interactive = isInteractive(node);
    const interacted = interactive ? stats?.interacted ?? 0 : null;
    return {
      nodeId,
      type: node?.type ?? "unknown",
      label: nodeLabel(node, nodeId),
      reached,
      interacted,
      progressionRate: interactive && reached > 0 ? Math.round(((interacted ?? 0) / reached) * 1000) / 10 : null,
      dropOff: interactive ? Math.max(reached - (interacted ?? 0), 0) : null,
      crmActions: stats?.crmActions ?? 0,
      handoffs: stats?.handoffs ?? 0,
      deliveryFailures: stats?.deliveryFailures ?? 0,
    };
  }).sort((a, b) => b.reached - a.reached || a.label.localeCompare(b.label));

  return {
    versions,
    selectedVersion,
    filters,
    summary,
    allTime,
    channels: channels.map((row) => ({
      channel: row.channel,
      conversations: n(row.conversations),
      completed: n(row.completed),
      handedOff: n(row.handedOff),
      crmActions: n(row.crmActions),
    })),
    nodes,
    trend: fillTrend(trendRows, filters),
    actions: actionRows.map((row) => ({ action: row.action, label: actionLabel(row.action), count: n(row.count) })),
    versionPerformance: versionRowsPerformance.map((row) => ({
      id: row.id,
      version: Number(row.version),
      publishedAt: row.createdAt,
      started: n(row.started),
      completed: n(row.completed),
      handedOff: n(row.handedOff),
      crmActions: n(row.crmActions),
      deliveryFailures: n(row.deliveryFailures),
    })),
  };
}
