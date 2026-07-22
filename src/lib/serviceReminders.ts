import { prisma } from "./db";
import { resolveTenantActor } from "./tenantActor";
import { getSetting } from "./settings";
import { sendEmail, renderTemplate } from "./email";
import { sendSms } from "./sms";
import { logAudit } from "./audit";
import { computeDue } from "./serviceDue";
import { formatDate } from "./format";

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

    const vars = {
      name: `${vehicle.contact.firstName} ${vehicle.contact.lastName ?? ""}`.trim(),
      first_name: vehicle.contact.firstName,
      model: vehicle.model,
      color: vehicle.color ?? "",
      due_date: due.nextDueDate ? formatDate(due.nextDueDate) : "soon",
      due_km: due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : "",
      current_km: due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "",
      user_name: "The Denago Cape Town team",
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

  const due = computeDue(vehicle);
  const firstUser = await resolveTenantActor();
  const first = contact.firstName;
  const dueWhen = due.nextDueDate ? formatDate(due.nextDueDate) : "soon";

  const templateId = await getSetting("SERVICE_REMINDER_TEMPLATE_ID");
  const template = templateId
    ? await prisma.emailTemplate.findUnique({ where: { id: templateId } })
    : null;

  const vars = {
    name: `${contact.firstName} ${contact.lastName ?? ""}`.trim(),
    first_name: first,
    model: vehicle.model,
    color: vehicle.color ?? "",
    due_date: dueWhen,
    due_km: due.nextDueKm != null ? `${due.nextDueKm.toLocaleString()} km` : "",
    current_km: due.currentKm != null ? `${due.currentKm.toLocaleString()} km` : "",
    user_name: "The Denago Cape Town team",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    value: "",
  };

  let channel: "email" | "sms";
  let subject = `Service reminder — your ${vehicle.model}`;
  let body: string;

  if (contact.email) {
    channel = "email";
    subject = template ? renderTemplate(template.subject, vars) : subject;
    body = template
      ? renderTemplate(template.body, vars)
      : `Hi ${first},\n\nA quick reminder that your ${vehicle.model} is due for a service (${dueWhen}). Reply or call us on 073 789 3438 and we'll book you in.\n\nWarm regards,\nDenago Cape Town`;
    const r = await sendEmail({ to: contact.email, subject, text: body });
    if (!r.ok) return { ok: false, error: r.error ?? "Email failed" };
  } else {
    channel = "sms";
    body = `Hi ${first}, your ${vehicle.model} is due for a service (${dueWhen}). Call Denago Cape Town on 073 789 3438 to book. Reply STOP to opt out.`;
    const r = await sendSms(contact.phone!, body);
    if (!r.ok) return { ok: false, error: r.error ?? "SMS failed" };
  }

  const dueKey = `${due.nextDueDate?.toISOString().slice(0, 10) ?? "nodate"}-${due.nextDueKm ?? "nokm"}`;
  await prisma.serviceReminderLog
    .upsert({
      where: { vehicleId_dueKey: { vehicleId: vehicle.id, dueKey } },
      create: { vehicleId: vehicle.id, dueKey, sentTo: contact.email ?? contact.phone ?? "" },
      update: { sentTo: contact.email ?? contact.phone ?? "" },
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
