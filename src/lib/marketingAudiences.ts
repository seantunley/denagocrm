import crypto from "node:crypto";
import { basePrisma, prisma } from "./db";
import { computeDue } from "./serviceDue";

export type AudienceRule = { field: string; operator: string; value?: unknown; legacyCriteria?: Record<string, unknown> };
export type AudienceGroup = { operator: "AND" | "OR"; rules: Array<AudienceRule | AudienceGroup>; exclusions?: Array<AudienceRule | AudienceGroup> };

const ALLOWED_FIELDS = new Set([
  "source", "province", "has_vehicle", "vehicle_model", "bought_before", "service_due",
  "lead_status", "product_interest", "created_date", "email_available", "phone_available",
  "tag", "quote_status", "customer_value",
]);
const ALLOWED_OPERATORS = new Set([
  "is_empty", "is_not_empty", "equals", "not_equals", "contains", "in",
  "greater_than", "greater_or_equal", "less_than", "less_or_equal",
]);
const MAX_DEPTH = 6;
const MAX_RULES = 100;

function group(value: unknown): value is AudienceGroup {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (((value as AudienceGroup).operator === "AND") || ((value as AudienceGroup).operator === "OR"))
    && Array.isArray((value as AudienceGroup).rules);
}

export function validateAudienceTree(tree: AudienceGroup) {
  let count = 0;
  const visit = (node: AudienceRule | AudienceGroup, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`Audience rules may be nested at most ${MAX_DEPTH} levels`);
    count += 1;
    if (count > MAX_RULES) throw new Error(`Audience may contain at most ${MAX_RULES} rules and groups`);
    if (group(node)) {
      if (node.rules.length === 0) throw new Error("Every audience group needs at least one rule");
      for (const child of node.rules) visit(child, depth + 1);
      for (const exclusion of node.exclusions ?? []) visit(exclusion, depth + 1);
      return;
    }
    if (node.legacyCriteria) {
      if (!node.legacyCriteria || typeof node.legacyCriteria !== "object" || Array.isArray(node.legacyCriteria)) {
        throw new Error("Legacy audience criteria are invalid");
      }
      return;
    }
    if (!ALLOWED_FIELDS.has(node.field)) throw new Error(`Unsupported audience field: ${node.field || "blank"}`);
    if (!ALLOWED_OPERATORS.has(node.operator)) throw new Error(`Unsupported audience operator: ${node.operator || "blank"}`);
    if (!new Set(["is_empty", "is_not_empty"]).has(node.operator) && node.value === undefined) {
      throw new Error(`${node.field.replaceAll("_", " ")} needs a comparison value`);
    }
  };
  visit(tree, 0);
  return tree;
}

function compare(actual: unknown, operator: string, expected: unknown) {
  if (operator === "is_empty") return actual == null || actual === "" || (Array.isArray(actual) && actual.length === 0);
  if (operator === "is_not_empty") return !compare(actual, "is_empty", expected);
  if (operator === "equals") return Array.isArray(actual) ? actual.map(String).includes(String(expected ?? "")) : String(actual ?? "") === String(expected ?? "");
  if (operator === "not_equals") return !compare(actual, "equals", expected);
  if (operator === "contains") return Array.isArray(actual)
    ? actual.map(String).some((item) => item.toLowerCase().includes(String(expected ?? "").toLowerCase()))
    : String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
  if (operator === "in") {
    const choices = (Array.isArray(expected) ? expected : String(expected ?? "").split(","))
      .map((value) => String(value).trim()).filter(Boolean);
    return choices.some((choice) => Array.isArray(actual) ? actual.map(String).includes(choice) : choice === String(actual ?? ""));
  }
  const actualNumber = actual instanceof Date ? actual.getTime() : Number(actual);
  const expectedDate = typeof expected === "string" ? Date.parse(expected) : Number.NaN;
  const expectedNumber = Number.isFinite(Number(expected)) ? Number(expected) : expectedDate;
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
  if (operator === "greater_than") return actualNumber > expectedNumber;
  if (operator === "greater_or_equal") return actualNumber >= expectedNumber;
  if (operator === "less_than") return actualNumber < expectedNumber;
  if (operator === "less_or_equal") return actualNumber <= expectedNumber;
  return false;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function valueFor(contact: Record<string, any>, field: string) {
  if (field === "source") return contact.source;
  if (field === "province") return contact.province;
  if (field === "has_vehicle") return (contact.vehicles ?? []).length > 0;
  if (field === "vehicle_model") return (contact.vehicles ?? []).map((vehicle: any) => vehicle.model);
  if (field === "bought_before") return (contact.leads ?? []).some((lead: any) => lead.status === "won");
  if (field === "service_due") return (contact.vehicles ?? []).some((vehicle: any) => ["due_soon", "overdue"].includes(computeDue(vehicle).status));
  if (field === "lead_status") return (contact.leads ?? []).map((lead: any) => lead.status);
  if (field === "product_interest") return (contact.leads ?? []).map((lead: any) => lead.productId);
  if (field === "created_date") return contact.createdAt;
  if (field === "email_available") return Boolean(contact.email);
  if (field === "phone_available") return Boolean(contact.whatsapp || contact.phone);
  if (field === "tag") return (contact.tags ?? []).map((tag: any) => tag.id);
  if (field === "quote_status") return (contact.quotes ?? []).map((quote: any) => quote.status);
  if (field === "customer_value") return (contact.leads ?? [])
    .filter((lead: any) => lead.status === "won")
    .reduce((sum: number, lead: any) => sum + Number(lead.valueCents ?? 0), 0);
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
    const criteria = node.legacyCriteria;
    return (!criteria.source || contact.source === criteria.source)
      && (!criteria.province || contact.province === criteria.province)
      && (!criteria.tagId || (contact.tags ?? []).some((tag: any) => tag.id === criteria.tagId))
      && (!criteria.hasVehicle || (contact.vehicles ?? []).length > 0)
      && (!criteria.wonOnly || (contact.leads ?? []).some((lead: any) => lead.status === "won"));
  }
  return compare(valueFor(contact, node.field), node.operator, node.value);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function explainAudience(tree: AudienceGroup) {
  validateAudienceTree(tree);
  const explain = (node: AudienceRule | AudienceGroup): string => group(node)
    ? `(${node.rules.map(explain).join(` ${node.operator} `)}${node.exclusions?.length ? ` excluding ${node.exclusions.map(explain).join(" OR ")}` : ""})`
    : node.legacyCriteria
      ? "historical audience criteria"
      : `${node.field.replaceAll("_", " ")} ${node.operator.replaceAll("_", " ")} ${String(node.value ?? "")}`;
  return explain(tree);
}

export async function evaluateAudience(tree: AudienceGroup, channel = "any") {
  validateAudienceTree(tree);
  const contacts = await prisma.contact.findMany({
    where: { deletedAt: null, marketingOptOut: false },
    take: 5000,
    include: {
      tags: true,
      vehicles: { where: { deletedAt: null }, include: { serviceRecords: true, mileageLogs: true } },
      leads: { where: { deletedAt: null } },
      quotes: { where: { deletedAt: null } },
    },
  });
  return contacts
    .filter((contact) => matchesNode(contact, tree))
    .filter((contact) => channel === "email" ? Boolean(contact.email) : channel === "sms" ? Boolean(contact.whatsapp || contact.phone) : true);
}

export async function saveAudienceVersion(args: {
  segmentId: string;
  tenantId: string | null;
  tree: AudienceGroup;
  userId: string;
  userName: string;
}) {
  validateAudienceTree(args.tree);
  const explanation = explainAudience(args.tree);
  const count = (await evaluateAudience(args.tree)).length;
  return basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audience-version:${args.segmentId}`}))`;
    const segments = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", COALESCE("status", 'active') AS "status"
      FROM "Segment"
      WHERE "id" = ${args.segmentId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
      FOR UPDATE
    `;
    if (!segments[0]) throw new Error("Audience not found");
    if (segments[0].status === "archived") throw new Error("Archived audiences cannot be edited");
    const rows = await tx.$queryRaw<Array<{ version: number }>>`
      SELECT COALESCE(MAX("version"), 0) + 1 AS "version"
      FROM "MarketingAudienceVersion"
      WHERE "segmentId" = ${args.segmentId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
    `;
    const version = Number(rows[0]?.version ?? 1);
    await tx.$executeRaw`
      INSERT INTO "MarketingAudienceVersion" (
        "id", "tenantId", "segmentId", "version", "ruleTree", "explanation", "createdById", "createdByName"
      ) VALUES (
        ${`mav_${crypto.randomUUID()}`}, ${args.tenantId}, ${args.segmentId}, ${version},
        ${JSON.stringify(args.tree)}::jsonb, ${explanation}, ${args.userId}, ${args.userName}
      )
    `;
    const updated = await tx.$executeRaw`
      UPDATE "Segment"
      SET "ruleTree" = ${JSON.stringify(args.tree)}::jsonb,
        "criteria" = ${JSON.stringify(args.tree)},
        "lastCalculatedCount" = ${count},
        "lastCalculatedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${args.segmentId}
        AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
        AND COALESCE("status", 'active') <> 'archived'
    `;
    if (updated !== 1) throw new Error("Audience changed while saving");
    return { version, count, explanation };
  });
}
