"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withTenantWrite } from "@/lib/tenantWrite";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  JOURNEY_TRIGGERS,
  parseConditionGroup,
  parseJourneyDefinition,
} from "@/lib/journeyTypes";
import {
  enrollJourneyNow,
  processJourneyEvents,
  processJourneyRuns,
} from "@/lib/journeys";

function parseObject(value: FormDataEntryValue | null, label: string) {
  if (!value || String(value).trim() === "") return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function journeyData(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const category = String(formData.get("category") ?? "automation");
  const trigger = String(formData.get("trigger") ?? "");
  if (!name) throw new Error("Journey name is required");
  if (!JOURNEY_TRIGGERS.includes(trigger as (typeof JOURNEY_TRIGGERS)[number])) {
    throw new Error("Unsupported journey trigger");
  }
  if (!new Set(["automation", "marketing"]).has(category)) throw new Error("Invalid journey category");

  const triggerConfig = parseObject(formData.get("triggerConfig"), "Trigger configuration");
  const rawConditions = parseObject(formData.get("entryConditions"), "Entry conditions");
  const rawDefinition = parseObject(formData.get("definition"), "Journey definition") ?? {
    startStepId: null,
    steps: [],
  };
  const entryConditions = parseConditionGroup(rawConditions);
  const definition = parseJourneyDefinition(rawDefinition);

  return {
    name: name.slice(0, 160),
    description: description?.slice(0, 1000) ?? null,
    category,
    trigger,
    triggerConfig: triggerConfig as Prisma.InputJsonValue | null,
    entryConditions: entryConditions as Prisma.InputJsonValue | null,
    definition: definition as Prisma.InputJsonValue,
  };
}

export async function createJourney(formData: FormData) {
  const user = await requireOwner();
  const data = journeyData(formData);
  // Atomic: journey + its first version in ONE transaction, tenant-stamped.
  const journey = await withTenantWrite(async (tx, tenantId) => {
    const j = await tx.journey.create({
      data: {
        name: data.name,
        description: data.description,
        category: data.category,
        createdById: user.id,
        tenantId,
      },
    });
    await tx.journeyVersion.create({
      data: {
        journeyId: j.id,
        version: 1,
        state: "draft",
        trigger: data.trigger,
        triggerConfig: data.triggerConfig ?? Prisma.JsonNull,
        entryConditions: data.entryConditions ?? Prisma.JsonNull,
        definition: data.definition,
        createdById: user.id,
        tenantId,
      },
    });
    return j;
  });
  await logAudit({
    action: "journey.created",
    summary: `Created journey “${journey.name}”`,
    user,
  });
  revalidatePath("/journeys");
  revalidatePath("/automations");
}

export async function saveJourneyDraft(journeyId: string, formData: FormData) {
  const user = await requireOwner();
  const data = journeyData(formData);
  await prisma.$transaction(async (tx) => {
    const journey = await tx.journey.findUniqueOrThrow({
      where: { id: journeyId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    const draft = journey.versions.find((version) => version.state === "draft");
    const versionData = {
      trigger: data.trigger,
      triggerConfig: data.triggerConfig ?? Prisma.JsonNull,
      entryConditions: data.entryConditions ?? Prisma.JsonNull,
      definition: data.definition,
      createdById: user.id,
    };
    if (draft) {
      await tx.journeyVersion.update({ where: { id: draft.id }, data: versionData });
    } else {
      await tx.journeyVersion.create({
        data: {
          journeyId,
          version: (journey.versions[0]?.version ?? 0) + 1,
          state: "draft",
          ...versionData,
        },
      });
    }
    await tx.journey.update({
      where: { id: journeyId },
      data: {
        name: data.name,
        description: data.description,
        category: data.category,
        status: journey.activeVersion ? journey.status : "draft",
      },
    });
  });
  await logAudit({
    action: "journey.draft_saved",
    summary: `Saved a new draft for journey “${data.name}”`,
    user,
  });
  revalidatePath("/journeys");
}

export async function publishJourney(journeyId: string) {
  const user = await requireOwner();
  const journey = await prisma.journey.findUniqueOrThrow({
    where: { id: journeyId },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  const draft = journey.versions.find((version) => version.state === "draft");
  if (!draft) throw new Error("This journey has no draft to publish");
  parseJourneyDefinition(draft.definition);

  await prisma.$transaction([
    prisma.journeyVersion.updateMany({
      where: { journeyId, state: "published" },
      data: { state: "retired" },
    }),
    prisma.journeyVersion.update({
      where: { id: draft.id },
      data: { state: "published", publishedAt: new Date() },
    }),
    prisma.journey.update({
      where: { id: journeyId },
      data: { activeVersion: draft.version, status: "active" },
    }),
  ]);
  await logAudit({
    action: "journey.published",
    summary: `Published journey “${journey.name}” version ${draft.version}`,
    user,
  });
  revalidatePath("/journeys");
}

export async function setJourneyStatus(journeyId: string, status: "active" | "paused" | "archived") {
  const user = await requireOwner();
  const journey = await prisma.journey.findUniqueOrThrow({ where: { id: journeyId } });
  if (status === "active" && !journey.activeVersion) throw new Error("Publish the journey before activating it");
  await prisma.journey.update({ where: { id: journeyId }, data: { status } });
  await logAudit({
    action: `journey.${status}`,
    summary: `${status === "active" ? "Activated" : status === "paused" ? "Paused" : "Archived"} journey “${journey.name}”`,
    user,
  });
  revalidatePath("/journeys");
}

export async function runJourneyNow(journeyId: string) {
  await requireOwner();
  const scheduled = await enrollJourneyNow(journeyId);
  const events = await processJourneyEvents(100);
  const runs = await processJourneyRuns(50);
  revalidatePath("/journeys");
  return { scheduled, events, runs };
}

function definition(steps: Array<Record<string, unknown>>) {
  return {
    startStepId: steps[0]?.id ?? null,
    steps: steps.map((step, index) => ({
      ...step,
      nextStepId: index < steps.length - 1 ? steps[index + 1].id : null,
    })),
  };
}

export async function installJourneyTemplates() {
  const user = await requireOwner();
  const templates = [
    {
      name: "New lead speed-to-contact",
      description: "Immediately alerts the team and creates a same-day follow-up task.",
      category: "automation",
      trigger: "lead_created",
      triggerConfig: {},
      entryConditions: { logic: "and", conditions: [] },
      definition: definition([
        { id: "notify", type: "send_push", config: { message: "New lead: {{name}} — {{model}}" } },
        { id: "task", type: "create_activity", config: { activityType: "call", summary: "Call new lead {{name}}", dueDays: 0 } },
      ]),
    },
    {
      name: "Won-customer welcome",
      description: "A delayed welcome message after a lead is marked won.",
      category: "marketing",
      trigger: "lead_won",
      triggerConfig: {},
      entryConditions: { logic: "and", conditions: [] },
      definition: definition([
        { id: "wait", type: "wait", config: { amount: 1, unit: "days" } },
        {
          id: "welcome",
          type: "send_email",
          config: {
            subject: "Welcome to the Denago Cape Town family",
            body: "Hi {{first_name}},\n\nThank you for choosing Denago Cape Town. We are delighted to have you with us and will be in touch with the next steps.\n\nWarm regards,\nDenago Cape Town",
          },
        },
      ]),
    },
    {
      name: "Purchase anniversary",
      description: "Annual anniversary greeting for vehicle owners.",
      category: "marketing",
      trigger: "purchase_anniversary",
      triggerConfig: {},
      entryConditions: { logic: "and", conditions: [] },
      definition: definition([
        {
          id: "anniversary-email",
          type: "send_email",
          config: {
            subject: "Happy Denago anniversary, {{first_name}}!",
            body: "Hi {{first_name}},\n\nHappy anniversary from Denago Cape Town. Thank you for being part of our community. If your vehicle needs a service, accessories or a battery health check, our team is ready to help.\n\nWarm regards,\nDenago Cape Town",
          },
        },
      ]),
    },
    {
      name: "Service win-back",
      description: "Re-engages owners who have been inactive for 12 months.",
      category: "marketing",
      trigger: "win_back",
      triggerConfig: { inactiveMonths: 12 },
      entryConditions: { logic: "and", conditions: [] },
      definition: definition([
        {
          id: "winback-email",
          type: "send_email",
          config: {
            subject: "We miss you at Denago Cape Town",
            body: "Hi {{first_name}},\n\nIt has been a while since we saw you. A quick service helps protect your vehicle and battery. Reply to this email and our team will arrange a convenient booking.\n\nWarm regards,\nDenago Cape Town",
          },
        },
        { id: "wait", type: "wait", config: { amount: 7, unit: "days" } },
        { id: "follow-up", type: "create_activity", config: { activityType: "call", summary: "Follow up win-back contact {{name}}", dueDays: 0 } },
      ]),
    },
  ];

  for (const item of templates) {
    const exists = await prisma.journey.findFirst({ where: { name: item.name, status: { not: "archived" } } });
    if (exists) continue;
    await withTenantWrite(async (tx, tenantId) => {
      const tpl = await tx.journey.create({
        data: {
          name: item.name,
          description: item.description,
          category: item.category,
          createdById: user.id,
          tenantId,
        },
      });
      await tx.journeyVersion.create({
        data: {
          journeyId: tpl.id,
          version: 1,
          state: "draft",
          trigger: item.trigger,
          triggerConfig: item.triggerConfig,
          entryConditions: item.entryConditions,
          definition: item.definition,
          createdById: user.id,
          tenantId,
        },
      });
    });
  }
  revalidatePath("/journeys");
}
