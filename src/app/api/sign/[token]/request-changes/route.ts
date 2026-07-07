import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";

const schema = z.object({
  kind: z.literal("quote"),
  note: z.string().min(2).max(2000),
});

/** Customer asks for changes to a quote (colour, extras, details) without declining it. */
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
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please describe the change you'd like." },
      { status: 422 }
    );
  }

  const quote = await prisma.quote.findFirst({ where: { signToken: token } });
  if (!quote) return NextResponse.json({ error: "Link not found" }, { status: 404 });
  if (quote.signedAt) {
    return NextResponse.json(
      { error: "This quote has already been signed — call us on 081 515 8319 for changes." },
      { status: 409 }
    );
  }

  const note = parsed.data.note.trim();
  await basePrisma.quote.update({
    where: { id: quote.id },
    data: { changeRequestedAt: new Date(), changeRequestNote: note },
  });

  const firstUser = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (firstUser) {
    await prisma.communication.create({
      data: {
        type: "note",
        direction: "inbound",
        subject: `Quote Q-${quote.number} — customer requested changes`,
        body: note,
        contactId: quote.contactId,
        leadId: quote.leadId,
        userId: firstUser.id,
      },
    });
  }
  await logAudit({
    action: "quote.changes_requested",
    summary: `Customer requested changes to quote Q-${quote.number} — “${note.slice(0, 200)}”`,
    contactId: quote.contactId,
    leadId: quote.leadId,
    userName: "Customer",
  });
  await sendPushToAll({
    title: "Quote change requested ✏️",
    body: `Q-${quote.number} — “${note.slice(0, 90)}”`,
    url: `/quotes/${quote.id}`,
  }).catch(() => {});

  return NextResponse.json({ ok: true });
}
