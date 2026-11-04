import "server-only";
import { prisma } from "./db";
import { routeIsWholeMessage, routeMatches, type FlowEntryContext } from "./flowRouteRule";
import { runtimeFlowTenantId } from "./flowScope";
export { FLOW_CHANNELS, FLOW_ROUTE_KINDS, normalizeRoutePattern, routeMatches } from "./flowRouteRule";
export type { FlowEntryContext, FlowRouteKind } from "./flowRouteRule";

/** The whole message is an enabled QR/keyword route's phrase on this channel (see routeIsWholeMessage). */
export async function messageIsRouteEntry(channel: string, text: string): Promise<boolean> {
  if (!text.trim()) return false;
  const routes = await prisma.botFlowRoute.findMany({
    where: { tenantId: runtimeFlowTenantId(), channel, enabled: true, kind: "keyword" },
    select: { kind: true, pattern: true },
  });
  return routes.some((route) => routeIsWholeMessage(route, text));
}

/** Return the currently published immutable version of the first matching route. */
export async function resolveRoutedFlowVersion(tenantId: string, channel: string, entry?: FlowEntryContext | null) {
  if (!entry) return null;
  const routes = await prisma.botFlowRoute.findMany({
    where: { tenantId, channel, enabled: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const route = routes.find((candidate) => routeMatches(candidate, entry));
  if (!route) return null;
  return prisma.botFlowVersion.findFirst({
    where: { id: route.publishedVersionId, tenantId, flowId: route.flowId, channel },
  });
}
