import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { contactName } from "@/lib/format";

/** Option lists for the Quick Actions create dialogs — one cached payload. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [products, stages, contacts, users, vehicles] = await Promise.all([
    prisma.product.findMany({
      where: { active: true },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.vehicle.findMany({
      include: { contact: true },
      orderBy: { model: "asc" },
      take: 500,
    }),
  ]);

  return NextResponse.json({
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      basePriceCents: p.basePriceCents,
      colors: p.colors.map((c) => c.name),
    })),
    stages,
    contacts: contacts.map((c) => ({ id: c.id, label: contactName(c) })),
    users,
    vehicles: vehicles.map((v) => ({ id: v.id, label: `${v.model} — ${contactName(v.contact)}` })),
  });
}
