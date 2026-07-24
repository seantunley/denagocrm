import crypto from "node:crypto";
import { basePrisma, prisma } from "./db";
import { computeDue } from "./serviceDue";

export type AudienceRule = { field: string; operator: string; value?: unknown; legacyCriteria?: Record<string, unknown> };
export type AudienceGroup = { operator: "AND" | "OR"; rules: Array<AudienceRule | AudienceGroup>; exclusions?: Array<AudienceRule | AudienceGroup> };

function group(value: unknown): value is AudienceGroup {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as AudienceGroup).rules);
}

function compare(actual: unknown, operator: string, expected: unknown) {
  if (operator === "is_empty") return actual == null || actual === "";
  if (operator === "is_not_empty") return actual != null && actual !== "";
  if (operator === "equals") return String(actual ?? "") === String(expected ?? "");
  if (operator === "not_equals") return String(actual ?? "") !== String(expected ?? "");
  if (operator === "contains") return Array.isArray(actual) ? actual.map(String).includes(String(expected)) : String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
  if (operator === "in") return (Array.isArray(expected) ? expected : String(expected ?? "").split(",")).map(String).includes(String(actual ?? ""));
  const a = Number(actual); const b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (operator === "greater_than") return a > b;
  if (operator === "greater_or_equal") return a >= b;
  if (operator === "less_than") return a < b;
  return a <= b;
}

function valueFor(contact: Record<string, any>, field: string) {
  if (field === "source") return contact.source;
  if (field === "province") return contact.province;
  if (field === "has_vehicle") return (contact.vehicles ?? []).length > 0;
  if (field === "vehicle_model") return (contact.vehicles ?? []).map((vehicle: any) => vehicle.model);
  if (field === "bought_before") return (contact.leads ?? []).some((lead: any) => lead.status === "won");
  if (field === "service_due") return (contact.vehicles ?? []).some((vehicle: any) => ["due_soon", "overdue"].includes(computeDue(vehicle).status));
  if (field === "lead_status") return (contact.leads ?? []).map((lead: any) => lead.status);
  if (field === "product_interest") return (contact.leads ?? []).map((lead: any) => lead.productId);
  if (field === "created_date") return contact.createdAt?.getTime?.() ?? null;
  if (field === "email_available") return Boolean(contact.email);
  if (field === "phone_available") return Boolean(contact.whatsapp || contact.phone);
  if (field === "tag") return (contact.tags ?? []).map((tag: any) => tag.id);
  if (field === "quote_status") return (contact.quotes ?? []).map((quote: any) => quote.status);
  if (field === "fleet") return Boolean(contact.fleet);
  if (field === "customer_value") return (contact.leads ?? []).filter((lead: any) => lead.status === "won").reduce((sum: number, lead: any) => sum + Number(lead.valueCents ?? 0), 0);
  return undefined;
}

function matchesNode(contact: Record<string, any>, node: AudienceRule | AudienceGroup): boolean {
  if (group(node)) {
    const results = node.rules.map((child) => matchesNode(contact, child));
    const included = node.operator === "OR" ? results.some(Boolean) : results.every(Boolean);
    const excluded = (node.exclusions ?? []).some((child) => matchesNode(contact, child));
    return included && !excluded;
  }
  if (node.legacyCriteria) {
    const c = node.legacyCriteria;
    return (!c.source || contact.source === c.source)
      && (!c.province || contact.province === c.province)
      && (!c.tagId || (contact.tags ?? []).some((tag: any) => tag.id === c.tagId))
      && (!c.hasVehicle || (contact.vehicles ?? []).length > 0)
      && (!c.wonOnly || (contact.leads ?? []).some((lead: any) => lead.status === "won"));
  }
  return compare(valueFor(contact, node.field), node.operator, node.value);
}

export function explainAudience(tree: AudienceGroup) {
  const explain = (node: AudienceRule | AudienceGroup): string => group(node)
    ? `(${node.rules.map(explain).join(` ${node.operator} `)}${node.exclusions?.length ? ` excluding ${node.exclusions.map(explain).join(" OR ")}` : ""})`
    : `${node.field.replaceAll("_", " ")} ${node.operator.replaceAll("_", " ")} ${String(node.value ?? "")}`;
  return explain(tree);
}

export async function evaluateAudience(tree: AudienceGroup, channel = "any") {
  const contacts = await prisma.contact.findMany({
    where: { deletedAt: null, marketingOptOut: false },
    take: 5000,
    include: {
      tags: true,
      vehicles: { where: { deletedAt: null }, include: { serviceRecords: true, mileageLogs: true } },
      leads: { where: { deletedAt: null } },
      quotes: { where: { deletedAt: null } },
      fleet: true,
    },
  });
  return contacts.filter((contact) => matchesNode(contact, tree)).filter((contact) => channel === "email" ? Boolean(contact.email) : channel === "sms" ? Boolean(contact.whatsapp || contact.phone) : true);
}

export async function saveAudienceVersion(args: { segmentId: string; tenantId: string | null; tree: AudienceGroup; userId: string; userName: string }) {
  const rows = await basePrisma.$queryRaw<Array<{ version: number }>>`SELECT COALESCE(MAX("version"), 0) + 1 AS version FROM "MarketingAudienceVersion" WHERE "segmentId" = ${args.segmentId}`;
  const version = Number(rows[0]?.version ?? 1);
  const explanation = explainAudience(args.tree);
  await basePrisma.$executeRaw`INSERT INTO "MarketingAudienceVersion" ("id", "tenantId", "segmentId", "version", "ruleTree", "explanation", "createdById", "createdByName") VALUES (${`mav_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.segmentId}, ${version}, ${JSON.stringify(args.tree)}::jsonb, ${explanation}, ${args.userId}, ${args.userName})`;
  const count = (await evaluateAudience(args.tree)).length;
  await basePrisma.$executeRaw`UPDATE "Segment" SET "ruleTree" = ${JSON.stringify(args.tree)}::jsonb, "criteria" = ${JSON.stringify(args.tree)}, "lastCalculatedCount" = ${count}, "lastCalculatedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${args.segmentId} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}`;
  return { version, count, explanation };
}
