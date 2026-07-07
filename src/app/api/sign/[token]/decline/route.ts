import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { runLeadAutomations } from "@/lib/automations";
import { sendPushToAll } from "@/lib/push";
import { formatZAR } from "@/lib/format";

const declineSchema = z.object({
  kind: z.literal("quote"),
  reason: z.string().min(2).max(1000),
});

/** Customer politely declines a quote via their signing link. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!/^[a-f0-9]{48,64}$/.test(token)) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = declineSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please tell us briefly why." }, { status: 422 });
  }

  const quote = await prisma.quote.findFirst({
    where: { signToken: token },
    include: { items: true },
  });
  if (!quote) return NextResponse.json({ error: "Link not found" }, { status: 404 });
  if (quote.signedAt) {
    return NextResponse.json(
      { error: "This quote has already been signed and can no longer be declined." },
      { status: 409 }
    );
  }

  const declined = await basePrisma.quote.updateMany({
    where: { id: quote.id, signedAt: null, declinedAt: null },
    data: {
      declinedAt: new Date(),
      declineReason: parsed.data.reason,
      status: "declined",
    },
  });
  if (declined.count === 0) {
    return NextResponse.json({ error: "This quote has already been declined." }, { status: 409 });
  }

  const total = quote.items.reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  await logAudit({
    action: "quote.declined",
    summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) declined online by the customer — “${parsed.data.reason}”`,
    contactId: quote.contactId,
    leadId: quote.leadId,
    userName: "Customer",
  });
  if (quote.leadId) await runLeadAutomations("quote_declined", quote.leadId).catch(() => {});
  await sendPushToAll({
    title: "Quote declined",
    body: `Q-${quote.number} — “${parsed.data.reason.slice(0, 80)}”`,
    url: `/quotes/${quote.id}`,
  }, "quote_feedback").catch(() => {});
  return NextResponse.json({ ok: true });
}
