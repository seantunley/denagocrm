import { prisma } from "@/lib/db";
import { createContact } from "@/app/actions/contacts";
import ContactForm from "@/components/ContactForm";

export default async function NewContactPage() {
  const users = await prisma.user.findMany({ orderBy: { name: "asc" } });
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">New contact</h1>
      <ContactForm
        action={createContact}
        submitLabel="Create contact"
        users={users.map((u) => ({ id: u.id, name: u.name }))}
      />
    </div>
  );
}
