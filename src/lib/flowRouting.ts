import "server-only";
import { prisma } from "./db";
import { routeMatches, type FlowEntryContext } from "./flowRouteRule";
export { FLOW_CHANNELS, FLOW_ROUTE_KINDS, normalizeRoutePattern, routeMatches } from "./flowRouteRule";
export type { FlowEntryContext, FlowRouteKind } from "./flowRouteRule";

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
