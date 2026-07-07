import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { runLeadAutomations } from "./automations";

export type IntakeLead = {
  name: string;
  email?: string | null;
  phone?: string | null;
  message?: string | null;
  model?: string | null;
  color?: string | null;
  source: string;
  externalId?: string | null;
  raw?: unknown;
};

/** Creates a lead in the first pipeline stage, matching the product by model name. */
export async function createIntakeLead(input: IntakeLead) {
  const firstStage = await prisma.pipelineStage.findFirst({
    orderBy: { order: "asc" },
  });
  if (!firstStage) throw new Error("No pipeline stages configured");

  let productId: string | null = null;
  let valueCents = 0;
  if (input.model) {
    const products = await prisma.product.findMany({ where: { active: true } });
    const needle = input.model.toLowerCase();
    const match =
      products.find((p) => p.name.toLowerCase() === needle) ??
      products.find(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          needle.includes(p.name.toLowerCase())
      );
    if (match) {
      productId = match.id;
      valueCents = match.basePriceCents;
    }
  }

  const titleParts = [input.model, input.color].filter(Boolean);
  const title = titleParts.length > 0 ? titleParts.join(" – ") : input.name;

  const max = await prisma.lead.aggregate({
    where: { stageId: firstStage.id },
    _max: { position: true },
  });

  const lead = await prisma.lead.create({
    data: {
      title,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      source: input.source,
      productId,
      color: input.color ?? null,
      valueCents,
      notes: input.message ?? null,
      stageId: firstStage.id,
      position: (max._max.position ?? 0) + 1,
      externalId: input.externalId ?? null,
      raw: input.raw != null ? JSON.stringify(input.raw) : null,
    },
  });
  await logAudit({
    action: "lead.received",
    summary: `Lead “${lead.title}” received via ${input.source}`,
    leadId: lead.id,
    userName: "System",
  });
  await sendPushToAll({
    title: "New lead 🚀",
    body: `${lead.title} — ${lead.name} (via ${input.source})`,
    url: `/leads/${lead.id}`,
  }, "lead_new").catch(() => {});
  await runLeadAutomations("lead_created", lead.id);
  return lead;
}
