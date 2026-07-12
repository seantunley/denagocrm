import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { updateContact } from "@/app/actions/contacts";
import ContactForm from "@/components/ContactForm";
import { contactName } from "@/lib/format";

export default async function EditContactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [contact, users] = await Promise.all([
    prisma.contact.findUnique({
      where: { id },
      include: { tags: true },
    }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
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
      />
    </div>
  );
}
