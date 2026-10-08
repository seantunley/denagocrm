import { prisma } from "./db";
import { customerRecordTenantId } from "./customerRecordTenant";
import { resolveTenantActor } from "./tenantActor";
import { getRegionalSettings, getSetting } from "./settings";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { logAudit } from "./audit";
import { computeDue } from "./serviceDue";
import { formatDate } from "./format";
import { companyTeamSignoff, getCompanyProfile } from "./companyProfile";
import { tenantEmailContent, tenantSmsContent } from "./signing/signingEmail";
import { canContactPerson, describeBlockedReason, firstAllowedChannel } from "./communicationPolicy";
import type { ModuleSendOutcome } from "./journeyTypes";

async function recordSuppressedReminder(
  vehicleId: string,
  contactId: string,
  model: string,
  /** Null for the manual button: a click is not a due-cycle decision. */
  dueKey: string | null,
  reason: string | undefined,
  userName: string,
) {
  if (dueKey) {
    await prisma.serviceReminderLog
      .upsert({
        where: { vehicleId_dueKey: { vehicleId, dueKey } },
        create: { vehicleId, dueKey, sentTo: `not sent: ${reason ?? "not contactable"}` },
        update: {},
      })
      .catch(() => {});
  }
  await logAudit({
    action: "communication.suppressed",
    summary: `Service reminder for ${model} not sent — ${describeBlockedReason(reason)}`,
    contactId,
    userName,
  });
}

/** One due-cycle of one vehicle: the date and km it is due at. */
function dueKeyOf(due: ReturnType<typeof computeDue>): string {
  return `${due.nextDueDate?.toISOString().slice(0, 10) ?? "nodate"}-${due.nextDueKm ?? "nokm"}`;
}

/**
 * What "is it due?" reads about a vehicle — ONE definition for the due scan and
 * the sender, both naming the workspace on the nested reads. The tenant guard
 * scopes only the top level, and service records and mileage logs carry their
 * own tenantId but reach a vehicle by vehicleId alone: an unscoped nested read
 * would let a mis-stamped row from another workspace become the "latest"
 * service or mileage and change the reminder sent (#787 review).
 */
const dueVehicleInclude = (tenantId: string) => ({
  contact: true,
  serviceRecords: { where: { tenantId }, orderBy: { serviceDate: "desc" as const }, take: 1 },
  mileageLogs: { where: { tenantId }, orderBy: { recordedAt: "desc" as const }, take: 1 },
});

/**
 * Vehicles due soon or overdue whose customer has an email address and hasn't
 * been reminded for this due-cycle — what the "Vehicle is due for a service"
 * journey trigger enrols. Each cycle is reminded once (ServiceReminderLog).
 */
export async function vehiclesDueForService(
  tenantId: string,
): Promise<Array<{ vehicleId: string; contactId: string; dueKey: string; model: string }>> {
  const vehicles = await prisma.vehicle.findMany({
    where: { tenantId, deletedAt: null },
    include: dueVehicleInclude(tenantId),
  });
  const due = vehicles.flatMap((vehicle) => {
    if (!vehicle.contact.email || vehicle.contact.deletedAt || vehicle.contact.tenantId !== tenantId) return [];
    const info = computeDue(vehicle);
    if (info.status !== "due_soon" && info.status !== "overdue") return [];
    return [{ vehicleId: vehicle.id, contactId: vehicle.contactId, dueKey: dueKeyOf(info), model: vehicle.model }];
  });
  if (due.length === 0) return [];
  const logged = await prisma.serviceReminderLog.findMany({
    where: { tenantId, vehicleId: { in: due.map((d) => d.vehicleId) } },
    select: { vehicleId: true, dueKey: true },
  });
  const done = new Set(logged.map((l) => `${l.vehicleId}:${l.dueKey}`));
  return due.filter((d) => !done.has(`${d.vehicleId}:${d.dueKey}`));
}

/**
 * Emails ONE customer that their vehicle is due (or overdue) for a service — the
 * "Send service-due reminder" journey step's sender. The ready-made "Service-due
 * reminder" journey is off until the owner switches it on in Journeys.
 *
 * Each due-cycle is reminded exactly once (ServiceReminderLog): a vehicle no
 * longer due, or already reminded for this cycle, is skipped. Uses the reminder
 * template picked under Settings → Email → Service reminders, else the
 * workspace's editable "Service reminder" email.
 */
export async function sendServiceDueReminder(vehicleId: string, tenantId: string): Promise<ModuleSendOutcome> {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, tenantId, deletedAt: null },
    include: dueVehicleInclude(tenantId),
  });
  if (!vehicle || vehicle.contact.tenantId !== tenantId) return { kind: "skipped", reason: "the vehicle is no longer on file" };
  if (!vehicle.contact.email) return { kind: "skipped", reason: "the customer has no email address" };
  const due = computeDue(vehicle);
  if (due.status !== "due_soon" && due.status !== "overdue") return { kind: "skipped", reason: "the vehicle is no longer due" };

  const dueKey = dueKeyOf(due);
  const already = await prisma.serviceReminderLog.findUnique({
    where: { vehicleId_dueKey: { vehicleId: vehicle.id, dueKey } },
  });
  if (already) return { kind: "skipped", reason: "already reminded for this service" };

  // Trashed contact, portal "Email service reminders" off, or service consent
  // withdrawn. The refusal is recorded against the due-cycle so it is audited
  // ONCE: a customer who switches reminders back on picks up from the next cycle
  // (the manual Remind button still works for this one).
  const verdict = await canContactPerson({
    contactId: vehicle.contactId,
    tenantId: vehicle.contact.tenantId,
    purpose: "service",
    requestedChannel: "email",
  });
  if (!verdict.allowed) {
    await recordSuppressedReminder(vehicle.id, vehicle.contactId, vehicle.model, dueKey, verdict.reason, "Automation");
    return { kind: "skipped", reason: describeBlockedReason(verdict.reason) };
  }

  const templateId = await getSetting("SERVICE_REMINDER_TEMPLATE_ID");
  const template = templateId ? await prisma.emailTemplate.findFirst({ where: { id: templateId, tenantId } }) : null;
  const company = await getCompanyProfile();
  const dueWhen = due.nextDueDate ? formatDate(due.nextDueDate, await getRegionalSettings()) : "soon";
  const name = `${vehicle.contact.firstName} ${vehicle.contact.lastName ?? ""}`.trim();
  const vars = {
    name,
    first_name: vehicle.contact.firstName,
    model: vehicle.model,
    color: vehicle.color ?? "",
    due_date: dueWhen,
    due_km: due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : "",
    current_km: due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "",
    user_name: companyTeamSignoff(company),
    email: vehicle.contact.email,
    phone: vehicle.contact.phone ?? "",
    value: "",
  };
  let subject: string;
  let text: string;
  let html: string | undefined;
  if (template) {
    subject = renderTemplate(template.subject, vars);
    text = renderTemplate(template.body, vars);
  } else {
    ({ subject, text, html } = await tenantEmailContent("service_reminder", tenantId, {
      first_name: vehicle.contact.firstName,
      recipient_name: name,
      model: vehicle.model,
      due_date: dueWhen,
    }));
  }
  const result = await sendEmail({ to: vehicle.contact.email, subject, text, html });
  if (!result.ok) return { kind: "failed", reason: "the email provider refused it" };

  await prisma.serviceReminderLog
    .upsert({
      where: { vehicleId_dueKey: { vehicleId: vehicle.id, dueKey } },
      create: { vehicleId: vehicle.id, dueKey, sentTo: vehicle.contact.email },
      update: { sentTo: vehicle.contact.email },
    });
  const firstUser = await resolveTenantActor();
  if (firstUser) {
    await prisma.communication.create({
      data: {
        type: "email",
        direction: "outbound",
        subject,
        body: `[Service reminder]\n\n${text}`,
        contactId: vehicle.contactId,
        userId: firstUser.id,
        tenantId: await customerRecordTenantId({ contactId: vehicle.contactId }),
      },
    });
  }
  await logAudit({
    action: "email.sent",
    summary: `Service reminder emailed for ${vehicle.model} (due ${dueWhen}${vars.due_km ? ` / ${vars.due_km}` : ""})`,
    contactId: vehicle.contactId,
    userName: "Automation",
  });
  return { kind: "sent" };
}

/**
 * Send a service reminder for ONE vehicle right now (from the Service Due
 * worklist). Ignores the global on/off toggle (it's a deliberate click) but
 * still records the due-cycle so the nightly job won't double up. Falls back
 * to SMS when the customer has no email.
 */
export async function remindVehicleService(
  vehicleId: string
): Promise<{ ok: boolean; channel?: "email" | "sms"; error?: string }> {
  // The vehicle's own workspace first, then its history read in THAT workspace
  // only (dueVehicleInclude) — the same reads the automatic reminder uses.
  const owner = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { tenantId: true } });
  const vehicle = owner?.tenantId
    ? await prisma.vehicle.findFirst({ where: { id: vehicleId, tenantId: owner.tenantId }, include: dueVehicleInclude(owner.tenantId) })
    : null;
  if (!vehicle) return { ok: false, error: "Vehicle not found" };
  const { contact } = vehicle;
  if (!contact.email && !contact.phone) return { ok: false, error: "No email or phone on file" };

  // A deliberate click still may not override the customer: email first, SMS
  // if email is refused (no address, or only email reminders switched off).
  const verdict = await firstAllowedChannel({
    contactId: contact.id,
    tenantId: contact.tenantId,
    purpose: "service",
    channels: ["email", "sms"],
  });
  if (!verdict.allowed || !verdict.destination) {
    await recordSuppressedReminder(vehicle.id, contact.id, vehicle.model, null, verdict.reason, "System");
    return { ok: false, error: `Not sent — ${describeBlockedReason(verdict.reason)}` };
  }

  const due = computeDue(vehicle);
  const firstUser = await resolveTenantActor();
  const first = contact.firstName;
  const dueWhen = due.nextDueDate ? formatDate(due.nextDueDate, await getRegionalSettings()) : "soon";

  const templateId = await getSetting("SERVICE_REMINDER_TEMPLATE_ID");
  const template = templateId
    ? await prisma.emailTemplate.findUnique({ where: { id: templateId } })
    : null;
  const company = await getCompanyProfile();

  const vars = {
    name: `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    first_name: first,
    model: vehicle.model,
    color: vehicle.color ?? "",
    due_date: dueWhen,
    due_km: due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : "",
    current_km: due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "",
    user_name: companyTeamSignoff(company),
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    value: "",
  };

  let channel: "email" | "sms";
  let subject: string;
  let body: string;
  // With no reminder template picked, the workspace's own editable "Service
  // reminder" email / SMS (Settings → Email templates) — not wording in code.
  const tenantId = contact.tenantId;
  const templateVars = {
    first_name: first,
    recipient_name: vars.name,
    model: vehicle.model,
    due_date: dueWhen,
  };

  if (verdict.channel === "email") {
    channel = "email";
    let html: string | undefined;
    if (template) {
      subject = renderTemplate(template.subject, vars);
      body = renderTemplate(template.body, vars);
    } else {
      const message = await tenantEmailContent("service_reminder", tenantId, templateVars);
      ({ subject, text: body, html } = message);
    }
    const r = await sendEmail({ to: verdict.destination, subject, text: body, html });
    if (!r.ok) return { ok: false, error: r.error ?? "Email failed" };
  } else {
    channel = "sms";
    subject = `Service reminder — your ${vehicle.model}`;
    body = await tenantSmsContent("service_reminder_sms", tenantId, templateVars);
    const r = await sendSms(verdict.destination, body);
    if (!r.ok) return { ok: false, error: r.error ?? "SMS failed" };
  }

  const dueKey = `${due.nextDueDate?.toISOString().slice(0, 10) ?? "nodate"}-${due.nextDueKm ?? "nokm"}`;
  await prisma.serviceReminderLog
    .upsert({
      where: { vehicleId_dueKey: { vehicleId: vehicle.id, dueKey } },
      create: { vehicleId: vehicle.id, dueKey, sentTo: verdict.destination },
      update: { sentTo: verdict.destination },
    })
    .catch(() => {});
  if (firstUser) {
    await prisma.communication.create({
      data: {
        type: channel,
        direction: "outbound",
        subject: `[Service reminder] ${subject}`,
        body,
        contactId: vehicle.contactId,
        userId: firstUser.id,
        tenantId: await customerRecordTenantId({ contactId: vehicle.contactId }),
      },
    });
  }
  await logAudit({
    action: channel === "email" ? "email.sent" : "sms.sent",
    summary: `Service reminder ${channel === "email" ? "emailed" : "texted"} for ${vehicle.model} (due ${dueWhen})`,
    contactId: vehicle.contactId,
    userName: "System",
  });
  return { ok: true, channel };
}
