import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { updateContact } from "@/app/actions/contacts";
import { requireContactAccess } from "@/lib/permissions";
import { listActingTenantStaff } from "@/lib/tenantActor";
import ContactForm from "@/components/ContactForm";
import { fleetPicker } from "@/lib/fleetDirectory";
import { contactName } from "@/lib/format";

export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The edit form's own guard, matching updateContact's. This page had none: it
  // sat under contacts/[id]/layout.tsx, whose guard is requireContactReadAccess —
  // so a READ grant opened the WRITE form, prefilled. The shipped Next docs are
  // explicit that a layout is the wrong place for this (authentication.md:1454:
  // layouts "will not prevent nested route segments and Server Actions from being
  // accessed"), and the layout does not re-render on client navigation either.
  //
  // updateContact itself is safe — requireContactAccess(id, "contacts.edit") at
  // actions/contacts.ts:104 — so this was an offered form that refused on submit,
  // after showing the record. Same key, same helper, one segment earlier.
  await requireContactAccess(id, "contacts.edit");
  const [contact, users, picker] = await Promise.all([
    prisma.contact.findUnique({
      where: { id },
      include: { tags: true },
    }),
    // The owner picker: staff of THIS tenant, not every User row. `User` is a
    // global model, so prisma.user.findMany is not tenant-scoped by anything.
    listActingTenantStaff(),
    fleetPicker(),
  ]);
  if (!contact) notFound();

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">Edit {contactName(contact)}</h1>
      <ContactForm
        action={updateContact.bind(null, contact.id)}
        defaults={{ ...contact, tags: contact.tags.map((t) => t.name).join(", ") }}
        submitLabel="Save changes"
        users={users.map((u) => ({ id: u.id, name: u.name }))}
        fleetPicker={picker}
      />
    </div>
  );
}
