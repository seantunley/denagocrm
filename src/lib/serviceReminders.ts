import { prisma } from "./db";
import { getSetting } from "./settings";
import { sendEmail, renderTemplate } from "./email";
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
    include: { contact: true, serviceRecords: true, mileageLogs: true },
  });

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
    const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
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
