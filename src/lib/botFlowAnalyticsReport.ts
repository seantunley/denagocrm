import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { getBotFlowVersionAnalytics, type BotFlowVersionAnalytics } from "./botFlowAnalytics";
import type { Flow, FlowNode } from "./flow";

export type FlowVersionReportMeta = {
  id: string;
  version: number;
  publishedAt: Date;
};

export type FlowChannelAnalytics = {
  channel: string;
  conversations: number;
  completed: number;
  handedOff: number;
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

export type BotFlowAnalyticsReport = {
  versions: FlowVersionReportMeta[];
  latestVersion: FlowVersionReportMeta | null;
  latest: BotFlowVersionAnalytics;
  allTime: BotFlowVersionAnalytics;
  channels: FlowChannelAnalytics[];
  nodes: FlowNodeReport[];
};

type VersionRow = { id: string; version: number; publishedAt: Date; definition: string };
type ChannelRow = {
  channel: string;
  conversations: bigint | number;
  completed: bigint | number;
  handedOff: bigint | number;
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

/**
 * Reporting is pinned to immutable published versions. The mutable draft is not
 * used to label historic nodes, so an owner editing today's canvas cannot rewrite
 * the meaning of yesterday's funnel.
 */
export async function getBotFlowAnalyticsReport(flowId: string): Promise<BotFlowAnalyticsReport> {
  const tenantId = writeTenantId() ?? DEFAULT_TENANT_ID;
  const versionRows = await basePrisma.$queryRaw<VersionRow[]>(Prisma.sql`
    SELECT "id", "version", "publishedAt", "definition"
      FROM "BotFlowVersion"
     WHERE "tenantId" = ${tenantId}
       AND "flowId" = ${flowId}
     ORDER BY "version" DESC
  `);
  const versions = versionRows.map((row) => ({ id: row.id, version: Number(row.version), publishedAt: row.publishedAt }));
  const latestVersion = versions[0] ?? null;
  const versionIds = versions.map((version) => version.id);
  const [allTime, latest, channels] = await Promise.all([
    getBotFlowVersionAnalytics(versionIds),
    latestVersion ? getBotFlowVersionAnalytics([latestVersion.id]) : Promise.resolve({ started: 0, completed: 0, handedOff: 0, deliveryFailures: 0, nodes: [] }),
    versionIds.length
      ? basePrisma.$queryRaw<ChannelRow[]>(Prisma.sql`
          SELECT
            "channel",
            COUNT(*) FILTER (WHERE "eventType" = 'flow_started') AS "conversations",
            COUNT(*) FILTER (WHERE "eventType" = 'flow_completed') AS "completed",
            COUNT(*) FILTER (WHERE "eventType" = 'flow_handoff') AS "handedOff"
          FROM "BotFlowEvent"
          WHERE "tenantId" = ${tenantId}
            AND "flowVersionId" IN (${Prisma.join(versionIds)})
          GROUP BY "channel"
          ORDER BY COUNT(*) FILTER (WHERE "eventType" = 'flow_started') DESC
        `)
      : Promise.resolve([] as ChannelRow[]),
  ]);

  const latestFlow = parseFlow(versionRows[0]?.definition);
  const latestByNode = new Map(latest.nodes.map((item) => [item.nodeId, item]));
  const nodeIds = new Set<string>([
    ...Object.keys(latestFlow?.nodes ?? {}),
    ...latest.nodes.map((item) => item.nodeId),
  ]);
  const nodes: FlowNodeReport[] = [...nodeIds].map((nodeId) => {
    const node = latestFlow?.nodes[nodeId];
    const stats = latestByNode.get(nodeId);
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
    latestVersion,
    latest,
    allTime,
    channels: channels.map((row) => ({
      channel: row.channel,
      conversations: n(row.conversations),
      completed: n(row.completed),
      handedOff: n(row.handedOff),
    })),
    nodes,
  };
}
