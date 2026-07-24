import "server-only";

import crypto from "crypto";
import { addDays, addHours } from "date-fns";
import { Prisma } from "@prisma/client";
import { basePrisma, prisma } from "./db";
import { renderTemplate } from "./email";
import { nextJobCardNumber } from "./numbering";
import { sendPushToAll } from "./push";
import { resolveTenantActor, resolveTenantMemberUser } from "./tenantActor";
import { sendWhatsAppText, waDigits } from "./whatsapp";
import { callAutomationWebhook } from "./automationWebhook";
import { hashJourneyKey } from "./journeyEngineShared";
import type { JourneyContext } from "./journeyContext";
import type { JourneyStep } from "./journeyTypes";

export type PlatformStepResult = {
  status: "completed" | "skipped" | "waiting";
  note: string;
  nextStepId?: string | null;
  nextRunAt?: Date;
  output?: Record<string, unknown>;
};

type PlatformArgs = {
  step: JourneyStep;
  context: JourneyContext;
  journeyName: string;
  runId: string;
  tenantId: string | null;
  vars: Record<string, string>;
  leadId: string | null;
  contactId: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(step: JourneyStep, key: string): string | null {
  const value = step.config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(step: JourneyStep, key: string, fallback = 0): number {
  const value = Number(step.config[key]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanValue(step: JourneyStep, key: string, fallback = false): boolean {
  const value = step.config[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "on";
  return fallback;
}

function source(context: JourneyContext) {
  const event = record(context.event);
  const source = record(context.source);
  return {
    event,
    source,
    sourceId: String(source.id ?? event.sourceId ?? "") || null,
    sourceType: String(source.entityType ?? event.entityType ?? "") || null,
  };
}

async function userIdFor(args: PlatformArgs, configured?: string | null) {
  if (configured) {
    const member = await resolveTenantMemberUser(configured);
    if (!member) throw new Error("The configured automation assignee is not an active member of this tenant");
    return member.id;
  }
  const lead = record(args.context.lead);
  const contact = record(args.context.contact);
  const owner = lead.assignedToId ?? contact.ownerId;
  if (typeof owner === "string" && owner) {
    const member = await resolveTenantMemberUser(owner);
    if (member) return member.id;
  }
  const actor = await resolveTenantActor();
  if (!actor) throw new Error("No active CRM user is available");
  return actor.id;
}

async function enqueueOutbox(args: PlatformArgs, kind: string, payload: Record<string, unknown>, status: "pending" | "blocked" = "pending") {
  const key = hashJourneyKey(`${args.runId}:${args.step.id}:${kind}`);
  return prisma.automationOutbox.upsert({
    where: { idempotencyKey: key },
    create: {
      tenantId: args.tenantId,
      kind,
      status,
      entityType: source(args.context).sourceType,
      entityId: source(args.context).sourceId,
      journeyRunId: args.runId,
      journeyStepId: args.step.id,
      payload: payload as Prisma.InputJsonValue,
      idempotencyKey: key,
      error: status === "blocked" ? "Waiting for the target integration to be connected" : null,
    },
    update: {},
  });
}

async function createPortalNotification(args: PlatformArgs) {
  if (!args.contactId) return null;
  const title = renderTemplate(text(args.step, "title") ?? `Update from ${args.journeyName}`, args.vars);
  const body = renderTemplate(text(args.step, "message") ?? text(args.step, "body") ?? "There is an update on your account.", args.vars);
  const href = text(args.step, "href") ?? "/portal";
  const kind = text(args.step, "kind") ?? "automation";
  const id = crypto.randomUUID();
  await basePrisma.$executeRaw`
    INSERT INTO "PortalNotification" ("id", "tenantId", "contactId", "title", "body", "href", "kind")
    VALUES (${id}, ${args.tenantId}, ${args.contactId}, ${title}, ${body}, ${href}, ${kind})`;
  return id;
}

async function createSupportCase(args: PlatformArgs) {
  if (!args.contactId) return null;
  const actorId = await userIdFor(args, text(args.step, "assignToId"));
  const subject = renderTemplate(text(args.step, "subject") ?? `Automation: ${args.journeyName}`, args.vars).slice(0, 250);
  const description = renderTemplate(text(args.step, "description") ?? text(args.step, "body") ?? "Created by an automated journey.", args.vars).slice(0, 5000);
  const priority = text(args.step, "priority") ?? "normal";
  return basePrisma.$transaction(async (tx) => {
    const item = await tx.customerCase.create({
      data: {
        tenantId: args.tenantId,
        subject,
        description,
        type: text(args.step, "caseType") ?? "support",
        priority,
        status: "open",
        source: "automation",
        contactId: args.contactId!,
        assignedToId: booleanValue(args.step, "assign", true) ? actorId : null,
        lastReplyBy: "staff",
        lastReplyAt: new Date(),
      },
    });
    await tx.customerCaseMessage.create({
      data: { tenantId: args.tenantId, caseId: item.id, userId: actorId, direction: "staff", type: "event", body: description },
    });
    return item;
  });
}

async function createJobCard(args: PlatformArgs) {
  const ref = source(args.context);
  const vehicleId = text(args.step, "vehicleId")
    ?? (typeof ref.source.vehicleId === "string" ? ref.source.vehicleId : null)
    ?? (ref.sourceType === "Vehicle" ? ref.sourceId : null);
  if (!vehicleId) return null;
  const vehicle = await prisma.vehicle.findFirst({ where: { id: vehicleId, deletedAt: null }, select: { id: true, contactId: true } });
  if (!vehicle) return null;
  const technicianId = await userIdFor(args, text(args.step, "technicianId"));
  const description = renderTemplate(text(args.step, "description") ?? `Created by ${args.journeyName}`, args.vars);
  return basePrisma.$transaction(async (tx) => {
    const number = await nextJobCardNumber(tx);
    return tx.jobCard.create({
      data: {
        tenantId: args.tenantId,
        number,
        vehicleId,
        contactId: vehicle.contactId,
        description,
        technicianId,
        priority: text(args.step, "priority") ?? "normal",
      },
    });
  });
}

async function createWorkshopBooking(args: PlatformArgs) {
  const userId = await userIdFor(args, text(args.step, "assignToId"));
  const dueHours = Math.max(0, numberValue(args.step, "dueHours", 24));
  const start = addHours(new Date(), dueHours);
  return prisma.activity.create({
    data: {
      type: text(args.step, "activityType") ?? "meeting",
      category: "workshop",
      summary: renderTemplate(text(args.step, "summary") ?? "Workshop booking", args.vars),
      note: renderTemplate(text(args.step, "note") ?? `Created by ${args.journeyName}`, args.vars),
      location: text(args.step, "branch") ?? args.vars.branch ?? null,
      dueDate: start,
      leadId: args.leadId,
      contactId: args.contactId,
      assignedToId: userId,
      createdById: userId,
    },
  });
}

async function updateAllowedField(args: PlatformArgs) {
  const field = text(args.step, "field");
  if (!field) return false;
  const configured = args.step.config.value;
  const rendered = typeof configured === "string" ? renderTemplate(configured, args.vars) : configured;
  const ref = source(args.context);

  if (field === "lead.source" && args.leadId) await prisma.lead.update({ where: { id: args.leadId }, data: { source: String(rendered ?? "") || null } });
  else if (field === "lead.valueCents" && args.leadId) await prisma.lead.update({ where: { id: args.leadId }, data: { valueCents: Math.max(0, Math.round(Number(rendered) || 0)) } });
  else if (field === "lead.quantity" && args.leadId) await prisma.lead.update({ where: { id: args.leadId }, data: { quantity: Math.max(1, Math.round(Number(rendered) || 1)) } });
  else if (field === "contact.source" && args.contactId) await prisma.contact.update({ where: { id: args.contactId }, data: { source: String(rendered ?? "") || null } });
  else if (field === "contact.province" && args.contactId) await prisma.contact.update({ where: { id: args.contactId }, data: { province: String(rendered ?? "") || null } });
  else if (field === "contact.marketingOptOut" && args.contactId) await prisma.contact.update({ where: { id: args.contactId }, data: { marketingOptOut: rendered === true || rendered === "true" } });
  else if (field === "case.priority" && ref.sourceType === "CustomerCase" && ref.sourceId) await prisma.customerCase.update({ where: { id: ref.sourceId }, data: { priority: String(rendered ?? "normal") } });
  else if (field === "testDrive.branch" && ref.sourceType === "TestDriveBooking" && ref.sourceId) await prisma.testDriveBooking.update({ where: { id: ref.sourceId }, data: { branch: String(rendered ?? "") } });
  else if (field === "testDrive.intendedRoute" && ref.sourceType === "TestDriveBooking" && ref.sourceId) await prisma.testDriveBooking.update({ where: { id: ref.sourceId }, data: { intendedRoute: String(rendered ?? "") || null } });
  else return false;
  return true;
}

async function assignBranch(args: PlatformArgs) {
  const branch = renderTemplate(text(args.step, "branch") ?? "", args.vars).trim();
  if (!branch) return false;
  const ref = source(args.context);
  if (ref.sourceType === "TestDriveBooking" && ref.sourceId) await prisma.testDriveBooking.update({ where: { id: ref.sourceId }, data: { branch } });
  else if (ref.sourceType === "DemoVehicle" && ref.sourceId) await prisma.demoVehicle.update({ where: { id: ref.sourceId }, data: { branch } });
  else {
    const stockUnitId = typeof ref.source.stockUnitId === "string" ? ref.source.stockUnitId : ref.sourceType === "StockUnit" ? ref.sourceId : null;
    if (!stockUnitId) return false;
    await prisma.stockUnit.update({ where: { id: stockUnitId }, data: { location: branch } });
  }
  return true;
}

async function assignTeam(args: PlatformArgs) {
  const teamId = text(args.step, "teamId");
  if (!teamId) return null;
  const team = await prisma.team.findFirst({
    where: { id: teamId, active: true, deletedAt: null },
    include: { members: true },
  });
  if (!team || !team.members.length) return null;
  const preferred = team.managerId ?? team.members.find((member) => member.isManager)?.userId;
  let assigneeId = preferred ?? null;
  if (!assigneeId) {
    const candidates = team.members.map((member) => member.userId);
    const workloads = await prisma.lead.groupBy({
      by: ["assignedToId"],
      where: { assignedToId: { in: candidates }, status: "open", deletedAt: null },
      _count: { _all: true },
    });
    const counts = new Map(workloads.map((row) => [row.assignedToId, row._count._all]));
    assigneeId = [...candidates].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0))[0] ?? null;
  }
  if (!assigneeId) return null;
  if (args.leadId) await prisma.lead.update({ where: { id: args.leadId }, data: { assignedToId: assigneeId } });
  else if (args.contactId) await prisma.contact.update({ where: { id: args.contactId }, data: { ownerId: assigneeId } });
  else return null;
  return assigneeId;
}

async function escalate(args: PlatformArgs) {
  const manager = await resolveTenantActor({ ownerOnly: true });
  if (!manager) return null;
  const ref = source(args.context);
  if (args.leadId && booleanValue(args.step, "reassign", true)) {
    await prisma.lead.update({ where: { id: args.leadId }, data: { assignedToId: manager.id } });
  }
  if (ref.sourceType === "CustomerCase" && ref.sourceId) {
    await prisma.customerCase.update({ where: { id: ref.sourceId }, data: { priority: "urgent", assignedToId: manager.id } });
  }
  const activity = await prisma.activity.create({
    data: {
      type: "todo",
      summary: renderTemplate(text(args.step, "summary") ?? `Escalation: ${args.journeyName}`, args.vars),
      note: renderTemplate(text(args.step, "note") ?? "Escalated automatically for management attention.", args.vars),
      dueDate: new Date(),
      leadId: args.leadId,
      contactId: args.contactId,
      assignedToId: manager.id,
      createdById: manager.id,
    },
  });
  await sendPushToAll({ title: "Automation escalation", body: activity.summary, url: args.leadId ? `/leads/${args.leadId}` : "/automations" });
  return manager.id;
}

async function createStockTransfer(args: PlatformArgs) {
  const ref = source(args.context);
  const stockUnitId = text(args.step, "stockUnitId")
    ?? (typeof ref.source.stockUnitId === "string" ? ref.source.stockUnitId : null)
    ?? (ref.sourceType === "StockUnit" ? ref.sourceId : null);
  const toBranch = renderTemplate(text(args.step, "toBranch") ?? "", args.vars).trim();
  if (!stockUnitId || !toBranch) return null;
  const existing = await prisma.stockTransferRequest.findFirst({ where: { journeyRunId: args.runId, journeyStepId: args.step.id } });
  if (existing) return existing;
  const unit = await prisma.stockUnit.findFirst({ where: { id: stockUnitId, deletedAt: null }, select: { location: true } });
  if (!unit) return null;
  return prisma.stockTransferRequest.create({
    data: {
      tenantId: args.tenantId,
      stockUnitId,
      fromBranch: unit.location,
      toBranch,
      notes: renderTemplate(text(args.step, "notes") ?? `Requested by ${args.journeyName}`, args.vars),
      requestedById: await userIdFor(args),
      journeyRunId: args.runId,
      journeyStepId: args.step.id,
    },
  });
}

async function setPortalAccess(args: PlatformArgs) {
  const viewerContactId = text(args.step, "viewerContactId") ?? args.contactId;
  const targetType = text(args.step, "targetType") ?? "contact";
  const targetId = text(args.step, "targetId") ?? (targetType === "contact" ? args.contactId : null);
  const mode = text(args.step, "mode") ?? "grant";
  const role = text(args.step, "role") ?? "viewer";
  if (!viewerContactId || !targetId || !["contact", "fleet"].includes(targetType)) return false;
  const actorId = await userIdFor(args);
  if (mode === "revoke") {
    if (targetType === "contact") await basePrisma.$executeRaw`UPDATE "PortalAccessGrant" SET "active" = false WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "viewerContactId" = ${viewerContactId} AND "grantedContactId" = ${targetId}`;
    else await basePrisma.$executeRaw`UPDATE "PortalAccessGrant" SET "active" = false WHERE "tenantId" IS NOT DISTINCT FROM ${args.tenantId} AND "viewerContactId" = ${viewerContactId} AND "fleetId" = ${targetId}`;
    return true;
  }
  const id = crypto.randomUUID();
  if (targetType === "contact") {
    await basePrisma.$executeRaw`
      INSERT INTO "PortalAccessGrant" ("id", "tenantId", "viewerContactId", "grantedContactId", "role", "createdById")
      VALUES (${id}, ${args.tenantId}, ${viewerContactId}, ${targetId}, ${role}, ${actorId})
      ON CONFLICT ("viewerContactId", "grantedContactId") WHERE "grantedContactId" IS NOT NULL
      DO UPDATE SET "active" = true, "role" = EXCLUDED."role", "createdById" = EXCLUDED."createdById", "tenantId" = EXCLUDED."tenantId"`;
  } else {
    await basePrisma.$executeRaw`
      INSERT INTO "PortalAccessGrant" ("id", "tenantId", "viewerContactId", "fleetId", "role", "createdById")
      VALUES (${id}, ${args.tenantId}, ${viewerContactId}, ${targetId}, ${role}, ${actorId})
      ON CONFLICT ("viewerContactId", "fleetId") WHERE "fleetId" IS NOT NULL
      DO UPDATE SET "active" = true, "role" = EXCLUDED."role", "createdById" = EXCLUDED."createdById", "tenantId" = EXCLUDED."tenantId"`;
  }
  return true;
}

export async function executePlatformJourneyAction(args: PlatformArgs): Promise<PlatformStepResult | null> {
  const { step } = args;
  switch (step.type) {
    case "send_whatsapp": {
      const lead = record(args.context.lead);
      const contact = record(args.context.contact);
      const to = String(contact.whatsapp ?? contact.phone ?? lead.phone ?? "").trim();
      if (!to) return { status: "skipped", note: "WhatsApp skipped: no phone number" };
      const message = renderTemplate(text(step, "message") ?? "", args.vars);
      if (!message) return { status: "skipped", note: "WhatsApp skipped: message is empty" };
      const result = await sendWhatsAppText(waDigits(to), message);
      if (!result.ok) throw new Error(result.error ?? "WhatsApp send failed");
      const userId = await userIdFor(args, text(step, "userId"));
      await prisma.communication.create({ data: { type: "whatsapp", direction: "outbound", body: `[Journey: ${args.journeyName}]\n\n${message}`, leadId: args.leadId, contactId: args.contactId, userId } });
      return { status: "completed", note: `WhatsApp sent to ${to}` };
    }
    case "send_portal_notification": {
      const id = await createPortalNotification(args);
      return id ? { status: "completed", note: "Portal notification created", output: { notificationId: id } } : { status: "skipped", note: "Portal notification skipped: no contact" };
    }
    case "create_case": {
      const item = await createSupportCase(args);
      return item ? { status: "completed", note: `Support case C-${item.number} created`, output: { caseId: item.id, number: item.number } } : { status: "skipped", note: "Case skipped: no contact" };
    }
    case "create_job_card": {
      const job = await createJobCard(args);
      return job ? { status: "completed", note: `Job card #${job.number} created`, output: { jobCardId: job.id, number: job.number } } : { status: "skipped", note: "Job card skipped: no vehicle" };
    }
    case "create_workshop_booking": {
      const activity = await createWorkshopBooking(args);
      return { status: "completed", note: "Workshop booking created", output: { activityId: activity.id } };
    }
    case "request_internal_approval": {
      const existing = await prisma.automationApprovalRequest.findFirst({ where: { journeyRunId: args.runId, journeyStepId: step.id } });
      if (existing?.status === "approved") return { status: "completed", note: "Internal approval granted", output: { approvalId: existing.id } };
      if (existing && ["rejected", "cancelled"].includes(existing.status)) {
        return { status: "completed", note: `Internal approval ${existing.status}`, nextStepId: null, output: { approvalId: existing.id, decision: existing.status } };
      }
      const approval = existing ?? await prisma.automationApprovalRequest.create({
        data: {
          tenantId: args.tenantId,
          title: renderTemplate(text(step, "title") ?? `Approval required: ${args.journeyName}`, args.vars),
          description: renderTemplate(text(step, "description") ?? "An automated workflow requires approval.", args.vars),
          entityType: source(args.context).sourceType,
          entityId: source(args.context).sourceId,
          contactId: args.contactId,
          leadId: args.leadId,
          requestedById: await userIdFor(args),
          assignedToId: await userIdFor(args, text(step, "assignToId")),
          journeyRunId: args.runId,
          journeyStepId: step.id,
          metadata: { journeyName: args.journeyName } as Prisma.InputJsonValue,
        },
      });
      if (!existing) await sendPushToAll({ title: "Approval required", body: approval.title, url: "/automations/approvals" });
      return {
        status: "waiting",
        note: "Waiting for internal approval",
        nextRunAt: addDays(new Date(), 3650),
        output: { approvalId: approval.id },
      };
    }
    case "update_field": {
      const changed = await updateAllowedField(args);
      return changed ? { status: "completed", note: "Field updated" } : { status: "skipped", note: "Field update skipped: unsupported field or source" };
    }
    case "assign_branch": {
      const changed = await assignBranch(args);
      return changed ? { status: "completed", note: "Branch assigned" } : { status: "skipped", note: "Branch assignment skipped: unsupported source" };
    }
    case "assign_team": {
      const assigneeId = await assignTeam(args);
      return assigneeId ? { status: "completed", note: "Record assigned to team", output: { assigneeId } } : { status: "skipped", note: "Team assignment skipped" };
    }
    case "escalate_to_manager": {
      const managerId = await escalate(args);
      return managerId ? { status: "completed", note: "Escalated to manager", output: { managerId } } : { status: "skipped", note: "Escalation skipped: no manager" };
    }
    case "create_stock_transfer": {
      const transfer = await createStockTransfer(args);
      return transfer ? { status: "completed", note: "Stock transfer requested", output: { transferId: transfer.id } } : { status: "skipped", note: "Stock transfer skipped: unit or destination missing" };
    }
    case "create_test_drive_follow_up": {
      const userId = await userIdFor(args, text(step, "assignToId"));
      const dueDays = Math.max(0, numberValue(step, "dueDays", 1));
      const activity = await prisma.activity.create({
        data: {
          type: text(step, "activityType") ?? "call",
          summary: renderTemplate(text(step, "summary") ?? "Follow up after test drive", args.vars),
          note: renderTemplate(text(step, "note") ?? `Created by ${args.journeyName}`, args.vars),
          dueDate: addDays(new Date(), dueDays),
          leadId: args.leadId,
          contactId: args.contactId,
          assignedToId: userId,
          createdById: userId,
        },
      });
      return { status: "completed", note: "Test-drive follow-up created", output: { activityId: activity.id } };
    }
    case "generate_document": {
      const item = await enqueueOutbox(args, "document.generate", { templateId: text(step, "templateId"), docType: text(step, "docType"), source: source(args.context).source, contactId: args.contactId, leadId: args.leadId });
      return { status: "completed", note: "Document generation queued", output: { outboxId: item.id } };
    }
    case "create_signing_request": {
      const item = await enqueueOutbox(args, "signing.create_request", { templateId: text(step, "templateId"), documentId: text(step, "documentId"), title: renderTemplate(text(step, "title") ?? args.journeyName, args.vars), source: source(args.context).source, contactId: args.contactId, leadId: args.leadId });
      return { status: "completed", note: "Signing request queued", output: { outboxId: item.id } };
    }
    case "call_webhook": {
      const url = text(step, "url");
      if (!url) return { status: "skipped", note: "Webhook skipped: no URL" };
      const result = await callAutomationWebhook({
        url,
        secret: text(step, "secret"),
        idempotencyKey: hashJourneyKey(`${args.runId}:${step.id}:webhook`),
        payload: { journey: args.journeyName, runId: args.runId, stepId: step.id, leadId: args.leadId, contactId: args.contactId, context: args.context },
      });
      return { status: "completed", note: `Webhook delivered (${result.status})`, output: { status: result.status } };
    }
    case "create_xero_draft_invoice": {
      const ref = source(args.context);
      const quoteId = text(step, "quoteId") ?? (ref.sourceType === "Quote" ? ref.sourceId : typeof ref.source.quoteId === "string" ? ref.source.quoteId : null);
      if (!quoteId) return { status: "skipped", note: "Xero draft skipped: no quote" };
      const item = await enqueueOutbox(args, "xero.draft_invoice", { quoteId, contactId: args.contactId }, "blocked");
      return { status: "completed", note: "Xero draft request recorded; awaiting Xero connection", output: { outboxId: item.id } };
    }
    case "set_portal_access": {
      const changed = await setPortalAccess(args);
      return changed ? { status: "completed", note: "Portal access updated" } : { status: "skipped", note: "Portal access skipped: missing viewer or target" };
    }
    default:
      return null;
  }
}
