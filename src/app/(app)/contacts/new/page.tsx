import { createContact } from "@/app/actions/contacts";
import ContactForm from "@/components/ContactForm";

export default function NewContactPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">New contact</h1>
      <ContactForm action={createContact} submitLabel="Create contact" />
    </div>
  );
}
