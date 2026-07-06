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
  const contact = await prisma.contact.findUnique({
    where: { id },
    include: { tags: true },
  });
  if (!contact) notFound();

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Edit {contactName(contact)}</h1>
      <ContactForm
        action={updateContact.bind(null, contact.id)}
        defaults={{ ...contact, tags: contact.tags.map((t) => t.name).join(", ") }}
        submitLabel="Save changes"
      />
    </div>
  );
}
