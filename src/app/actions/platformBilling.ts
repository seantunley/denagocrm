"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, ActionRefusal, type ActionResult } from "@/lib/actionResult";
import { basePrisma } from "@/lib/db";
import { requirePlatformAdminAction } from "@/lib/platformAuth";
import { logAuditStrict } from "@/lib/audit";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { usageFor } from "@/lib/usage";
import { METER_IDS, METERS, invoiceLines, invoiceNumber, invoiceTotals, monthHasEnded, planAmounts, termsInForce, usageMonth, type PlanAmounts } from "@/lib/usageMeters";
import { INVOICE_FROM_KEY, INVOICE_VAT_KEY, invoiceSettings } from "@/lib/platformInvoiceSettings";

const tenantPath = (tenantId: string) => `/platform/tenants/${tenantId}`;
const text = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();

/** Rands typed in a form → cents; blank → null; anything else refused. */
function cents(formData: FormData, key: string, label: string): number | null {
  const raw = text(formData, key).replace(/\s/g, "").replace(",", ".");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ActionRefusal(`${label} must be an amount of 0 or more.`);
  return Math.round(value * 100);
}

function amount(formData: FormData, key: string, label: string): number | null {
  const raw = text(formData, key).replace(/\s/g, "").replace(",", ".");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new ActionRefusal(`${label} must be 0 or more.`);
  return value;
}

function auditActor(actor: { id: string; name: string; email: string }) {
  // A PlatformAdmin, not a CRM User: attributed by name, id kept in metadata (see actions/tenants.ts).
  return { userName: actor.name, actorType: "platform_admin" as const, metadata: { platformAdminId: actor.id, platformAdminEmail: actor.email } };
}

/** The workspace's plan: name, monthly fee, per-meter allowances and overage prices, and who pays for AI. */
export async function setTenantPlanAction(tenantId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const tenant = await basePrisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, planName: true, planMonthlyCents: true, planIncluded: true, planOverage: true, platformAi: true },
    });
    if (!tenant) throw new ActionRefusal("Workspace not found.");
    const included: PlanAmounts = {};
    const overage: PlanAmounts = {};
    for (const id of METER_IDS) {
      if (!METERS[id].billable) continue;
      const inc = amount(formData, `included_${id}`, `${METERS[id].label} included`);
      const over = cents(formData, `overage_${id}`, `${METERS[id].label} price`);
      if (inc !== null) included[id] = inc;
      if (over !== null) overage[id] = over;
    }
    const data = {
      planName: text(formData, "planName").slice(0, 80) || null,
      planMonthlyCents: cents(formData, "planMonthly", "Monthly fee"),
      planIncluded: included,
      planOverage: overage,
      // The founding workspace pays for its own; switching it on there would mean nothing.
      platformAi: tenantId !== DEFAULT_TENANT_ID && formData.get("platformAi") === "on",
    };
    // The terms are also kept against this month, so months already past keep the prices they had (termsInForce).
    const month = usageMonth();
    const terms = { planName: data.planName, monthlyCents: data.planMonthlyCents, included, overage, updatedBy: actor.email };
    await basePrisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data });
      await tx.tenantPlanTerms.upsert({ where: { tenantId_month: { tenantId, month } }, create: { tenantId, month, ...terms }, update: terms });
    });
    await logAuditStrict({
      action: "tenant.plan_changed",
      summary: `Updated the plan for “${tenant.name}”${data.platformAi !== tenant.platformAi ? (data.platformAi ? " — platform now supplies AI & voice" : " — platform no longer supplies AI & voice") : ""}`,
      entityType: "Tenant",
      entityId: tenantId,
      ...auditActor(actor),
      before: { planName: tenant.planName, planMonthlyCents: tenant.planMonthlyCents, planIncluded: tenant.planIncluded, planOverage: tenant.planOverage, platformAi: tenant.platformAi },
      after: data,
    });
    revalidatePath(tenantPath(tenantId));
    return { success: "Plan saved" };
  });
}

/** Who invoices come from (name, address, VAT number, bank details) and the VAT rate charged. */
export async function setInvoiceSettingsAction(tenantId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const from = text(formData, "fromText").slice(0, 2000);
    const vat = amount(formData, "vatRatePct", "VAT rate");
    if (vat !== null && vat > 100) throw new ActionRefusal("VAT rate can't be over 100%.");
    const before = await invoiceSettings();
    for (const [key, value] of [[INVOICE_FROM_KEY, from], [INVOICE_VAT_KEY, String(vat ?? 0)]] as const) {
      // Platform-level, kept on the founding workspace's settings rows; written explicitly, not via ambient scope.
      await basePrisma.appSetting.upsert({
        where: { tenantId_key: { tenantId: DEFAULT_TENANT_ID, key } },
        update: { value },
        create: { tenantId: DEFAULT_TENANT_ID, key, value },
      });
    }
    await logAuditStrict({
      action: "platform.invoice_settings_changed",
      summary: "Updated who invoices come from and the VAT rate",
      entityType: "Tenant",
      entityId: DEFAULT_TENANT_ID,
      ...auditActor(actor),
      before,
      after: { fromText: from, vatRatePct: vat ?? 0 },
    });
    revalidatePath(tenantPath(tenantId));
    return { success: "Invoice details saved" };
  });
}

/**
 * Creates the invoice for one month from the plan and that month's metered usage. One live invoice per
 * workspace per month: the workspace row is locked while that is checked, so a double click makes one.
 */
export async function createTenantInvoiceAction(tenantId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const period = text(formData, "period");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ActionRefusal("Choose the month to invoice.");
    // Usage is still being counted until the month ends, and a month gets one live invoice — so only ended months.
    if (!monthHasEnded(period)) throw new ActionRefusal(`${period} hasn't ended yet. Invoice it once it has, so all its usage is on the invoice.`);
    const settings = await invoiceSettings();
    if (!settings.fromText) throw new ActionRefusal("Fill in “Invoice from” first — it's printed on every invoice.");
    const usage = await usageFor(tenantId, period);

    const invoice = await basePrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      if (!tenant) throw new ActionRefusal("Workspace not found.");
      const existing = await tx.tenantInvoice.findFirst({ where: { tenantId, period, status: { not: "void" } }, select: { number: true } });
      if (existing) throw new ActionRefusal(`${period} is already invoiced (${invoiceNumber(existing.number)}). Void it first to invoice again.`);
      // The terms that applied in that month, not today's plan (review of #1002).
      const terms = termsInForce(await tx.tenantPlanTerms.findMany({ where: { tenantId, month: { lte: period } } }), period);
      if (!terms) throw new ActionRefusal(`This workspace had no plan in ${period}, so there's nothing to invoice.`);
      const lines = invoiceLines(
        { name: terms.planName, monthlyCents: terms.monthlyCents, included: planAmounts(terms.included), overage: planAmounts(terms.overage) },
        usage,
        period,
      );
      if (!lines.length) throw new ActionRefusal("Nothing to invoice: this workspace has no plan fee and no usage over its plan for that month.");
      const totals = invoiceTotals(lines, settings.vatRatePct);
      const created = await tx.tenantInvoice.create({
        data: { tenantId, period, lines, vatRatePct: settings.vatRatePct, fromText: settings.fromText, createdBy: actor.email, ...totals },
      });
      return { ...created, tenantName: tenant.name };
    });

    await logAuditStrict({
      action: "tenant.invoice_created",
      summary: `Invoiced “${invoice.tenantName}” for ${period}: ${invoiceNumber(invoice.number)}`,
      entityType: "TenantInvoice",
      entityId: invoice.id,
      ...auditActor(actor),
      after: { tenantId, period, totalCents: invoice.totalCents },
    });
    revalidatePath(tenantPath(tenantId));
    return { success: `${invoiceNumber(invoice.number)} created` };
  });
}

async function setInvoiceStatus(tenantId: string, invoiceId: string, to: "paid" | "void"): Promise<ActionResult> {
  return asActionResult(async () => {
    const actor = await requirePlatformAdminAction();
    const invoice = await basePrisma.tenantInvoice.findFirst({ where: { id: invoiceId, tenantId } });
    if (!invoice) throw new ActionRefusal("Invoice not found.");
    const from = to === "paid" ? ["issued"] : ["issued", "paid"];
    // Conditional on the status it had: two people pressing at once change it once.
    const { count } = await basePrisma.tenantInvoice.updateMany({
      where: { id: invoiceId, tenantId, status: { in: from } },
      data: to === "paid" ? { status: "paid", paidAt: new Date() } : { status: "void", voidedAt: new Date() },
    });
    if (!count) throw new ActionRefusal(`${invoiceNumber(invoice.number)} is already ${invoice.status}.`);
    await logAuditStrict({
      action: to === "paid" ? "tenant.invoice_paid" : "tenant.invoice_voided",
      summary: `${invoiceNumber(invoice.number)} marked ${to === "paid" ? "paid" : "void"}`,
      entityType: "TenantInvoice",
      entityId: invoiceId,
      ...auditActor(actor),
      before: { status: invoice.status },
      after: { status: to },
    });
    revalidatePath(tenantPath(invoice.tenantId));
    return { success: to === "paid" ? "Marked paid" : "Invoice voided" };
  });
}

export async function markTenantInvoicePaidAction(tenantId: string, invoiceId: string): Promise<ActionResult> {
  return setInvoiceStatus(tenantId, invoiceId, "paid");
}

export async function voidTenantInvoiceAction(tenantId: string, invoiceId: string): Promise<ActionResult> {
  return setInvoiceStatus(tenantId, invoiceId, "void");
}
