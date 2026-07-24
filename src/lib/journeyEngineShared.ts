import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { evaluateConditions, parseConditionGroup, parseJourneyDefinition } from "./journeyTypes";
import { loadJourneyContext, type JourneyEntityType } from "./journeyContext";

export const hashJourneyKey = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");

export const jsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export function getActiveVersion<T extends { version: number }>(journey: {
  activeVersion: number | null;
  versions: T[];
}): T | null {
  return journey.versions.find((version) => version.version === journey.activeVersion) ?? null;
}

export async function enqueueJourneyRun(args: {
  journey: { id: string; tenantId: string | null; name: string; category: string };
  version: {
    id: string;
    version: number;
    entryConditions: Prisma.JsonValue | null;
    definition: Prisma.JsonValue;
  };
  entityType: JourneyEntityType;
  entityId: string;
  eventKey: string;
  payload: Record<string, unknown>;
}) {
  const context = await loadJourneyContext(args.entityType, args.entityId, args.payload);
  if (!context) return false;
  const conditions = parseConditionGroup(args.version.entryConditions);
  if (!evaluateConditions(conditions, context)) return false;
  const definition = parseJourneyDefinition(args.version.definition);
  if (!definition.startStepId) return false;
  const lead = (context.lead ?? {}) as Record<string, unknown>;
  const contact = (context.contact ?? {}) as Record<string, unknown>;
  const idempotencyKey = hashJourneyKey(
    `${args.journey.id}:${args.version.version}:${args.eventKey}:${args.entityType}:${args.entityId}`
  );

  try {
    await prisma.journeyRun.create({
      data: {
        tenantId: args.journey.tenantId,
        journeyId: args.journey.id,
        journeyVersionId: args.version.id,
        entityType: args.entityType,
        entityId: args.entityId,
        leadId: typeof lead.id === "string" ? lead.id : null,
        contactId: typeof contact.id === "string" ? contact.id : null,
        currentStepId: definition.startStepId,
        context: context as Prisma.InputJsonValue,
        idempotencyKey,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}
