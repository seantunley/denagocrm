import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { updateLead } from "@/app/actions/leads";
import LeadForm from "@/components/LeadForm";
import { contactName } from "@/lib/format";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [lead, products, stages, contacts, users] = await Promise.all([
    prisma.lead.findUnique({ where: { id } }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    prisma.contact.findMany({ orderBy: { firstName: "asc" }, take: 500 }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!lead) notFound();

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Edit lead</h1>
      <LeadForm
        action={updateLead.bind(null, lead.id)}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          basePriceCents: p.basePriceCents,
          colors: p.colors.map((c) => c.name),
        }))}
        stages={stages.map((s) => ({ id: s.id, name: s.name }))}
        contacts={contacts.map((c) => ({ id: c.id, label: contactName(c) }))}
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        defaults={lead}
        submitLabel="Save changes"
      />
    </div>
  );
}
