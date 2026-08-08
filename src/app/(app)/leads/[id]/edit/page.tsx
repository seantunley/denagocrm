import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { updateLead } from "@/app/actions/leads";
import { getAccessibleContactIds, requireLeadAccess } from "@/lib/permissions";
import { listTenantStaff } from "@/lib/tenantActor";
import LeadForm from "@/components/LeadForm";
import { contactName } from "@/lib/format";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Same shape as the contact edit form: no guard of its own, sitting under
  // leads/[id]/layout.tsx whose guard is requireLeadReadAccess — a read grant
  // opened the write form. updateLead already demands leads.edit; this is that
  // same demand, one segment earlier, so the form is not offered at all.
  const user = await requireLeadAccess(id, "leads.edit");
  const accessibleContactIds = await getAccessibleContactIds(user);
  const [lead, products, stages, contacts, users] = await Promise.all([
    prisma.lead.findUnique({ where: { id } }),
    prisma.product.findMany({
      where: { active: true },
      include: { colors: true },
      orderBy: { name: "asc" },
    }),
    prisma.pipelineStage.findMany({ orderBy: { order: "asc" } }),
    // The customer picker. `null` means unrestricted; `[]` means nothing
    // accessible and must stay an impossible match, not an absent filter.
    prisma.contact.findMany({
      where: accessibleContactIds ? { id: { in: accessibleContactIds } } : {},
      orderBy: { firstName: "asc" },
      take: 500,
    }),
    listTenantStaff(),
  ]);
  if (!lead) notFound();

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">Edit lead</h1>
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
