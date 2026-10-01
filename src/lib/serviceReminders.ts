import { prisma } from "./db";
import { customerRecordTenantId } from "./customerRecordTenant";
import { resolveTenantActor } from "./tenantActor";
import { getRegionalSettings, getSetting } from "./settings";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { logAudit } from "./audit";
import { computeDue } from "./serviceDue";
import { formatDate } from "./format";
import { companyContactPhrase, companyTeamSignoff, getCompanyProfile } from "./companyProfile";
import { canContactPerson, describeBlockedReason, firstAllowedChannel } from "./communicationPolicy";

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

/**
 * Emails customers whose vehicle is due (or overdue) for a service.
 * Each due-cycle is reminded exactly once (tracked in ServiceReminderLog).
 * Enabled via Settings → Email → Service reminders.
 */
export async function runServiceReminders(): Promise<number> {
  const enabled = (await getSetting("SERVICE_REMINDER_ENABLED")) === "true";
  if (!enabled) return 0;
  const templateId = await getSetting("SERVICE_REMINDER_TEMPLATE_ID");
  if (!templateId) return 0;
  const template = await prisma.emailTemplate.findUnique({ where: { id: templateId } });
  if (!template) return 0;

  const vehicles = await prisma.vehicle.findMany({
    include: {
      contact: true,
      serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });
  const firstUser = await resolveTenantActor();
  const company = await getCompanyProfile();
  const regional = await getRegionalSettings();

  let sent = 0;
  for (const vehicle of vehicles) {
    if (!vehicle.contact.email) continue;
    const due = computeDue(vehicle);
    if (due.status !== "due_soon" && due.status !== "overdue") continue;

    const dueKey = `${due.nextDueDate?.toISOString().slice(0, 10) ?? "nodate"}-${due.nextDueKm ?? "nokm"}`;
    const already = await prisma.serviceReminderLog.findUnique({
      where: { vehicleId_dueKey: { vehicleId: vehicle.id, dueKey } },
    });
    if (already) continue;

    // Trashed contact, portal "Email service reminders" off, or service consent
    // withdrawn. The refusal is recorded against the due-cycle so it is audited
    // ONCE, not every night: a customer who switches reminders back on picks up
    // from the next cycle (the manual Remind button still works for this one).
    const verdict = await canContactPerson({
      contactId: vehicle.contactId,
      tenantId: vehicle.contact.tenantId,
      purpose: "service",
      requestedChannel: "email",
    });
    if (!verdict.allowed) {
      await recordSuppressedReminder(vehicle.id, vehicle.contactId, vehicle.model, dueKey, verdict.reason, "Automation");
      continue;
    }

    const vars = {
      name: `${vehicle.contact.firstName} ${vehicle.contact.lastName ?? ""}`.trim(),
      first_name: vehicle.contact.firstName,
      model: vehicle.model,
      color: vehicle.color ?? "",
      due_date: due.nextDueDate ? formatDate(due.nextDueDate, regional) : "soon",
      due_km: due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : "",
      current_km: due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "",
      user_name: companyTeamSignoff(company),
      email: vehicle.contact.email,
      phone: vehicle.contact.phone ?? "",
      value: "",
    };
    const result = await sendEmail({
      to: vehicle.contact.email,
      subject: renderTemplate(template.subject, vars),
      text: renderTemplate(template.body, vars),
    });
    if (!result.ok) continue;

    await prisma.serviceReminderLog.create({
      data: { vehicleId: vehicle.id, dueKey, sentTo: vehicle.contact.email },
    });
    await prisma.communication.create({
      data: {
        type: "email",
        direction: "outbound",
        subject: renderTemplate(template.subject, vars),
        body: `[Service reminder]\n\n${renderTemplate(template.body, vars)}`,
        contactId: vehicle.contactId,
        userId: firstUser!.id,
        tenantId: await customerRecordTenantId({ contactId: vehicle.contactId }),
      },
    });
    await logAudit({
      action: "email.sent",
      summary: `Service reminder emailed to ${vehicle.contact.email} for ${vehicle.model} (due ${vars.due_date}${vars.due_km ? ` / ${vars.due_km}` : ""})`,
      contactId: vehicle.contactId,
      userName: "Automation",
    });
    sent++;
  }
  return sent;
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
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: {
      contact: true,
      serviceRecords: { orderBy: { serviceDate: "desc" }, take: 1 },
      mileageLogs: { orderBy: { recordedAt: "desc" }, take: 1 },
    },
  });
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
  let subject = `Service reminder — your ${vehicle.model}`;
  let body: string;

  if (verdict.channel === "email") {
    channel = "email";
    subject = template ? renderTemplate(template.subject, vars) : subject;
    body = template
      ? renderTemplate(template.body, vars)
      : `Hi ${first},\n\nA quick reminder that your ${vehicle.model} is due for a service (${dueWhen}). Reply or call us${company.phone ? ` on ${company.phone}` : ""} and we'll book you in.\n\nWarm regards,\n${company.name}`;
    const r = await sendEmail({ to: verdict.destination, subject, text: body });
    if (!r.ok) return { ok: false, error: r.error ?? "Email failed" };
  } else {
    channel = "sms";
    body = `Hi ${first}, your ${vehicle.model} is due for a service (${dueWhen}). Call ${companyContactPhrase(company)} to book. Reply STOP to opt out.`;
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
