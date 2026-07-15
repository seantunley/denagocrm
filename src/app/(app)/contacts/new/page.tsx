import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  CarFront,
  CheckCircle2,
  MessageSquareText,
} from "lucide-react";
import { createContact } from "@/app/actions/contacts";
import ContactForm from "@/components/ContactForm";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { SectionHeading, Surface } from "@/components/visual-system";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";

const nextSteps = [
  { icon: MessageSquareText, label: "Start a conversation", detail: "Email, WhatsApp or call from the customer timeline." },
  { icon: CarFront, label: "Register their vehicle", detail: "Build service and ownership history against one profile." },
  { icon: ArrowRight, label: "Create an opportunity", detail: "Open a sales lead without capturing their details again." },
];

export default async function NewContactPage() {
  await requirePermission("contacts.create");
  const users = await prisma.user.findMany({ orderBy: { name: "asc" } });

  return (
    <div className="space-y-6">
      <Link
        href="/contacts"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to contacts
      </Link>

      <PageHeader
        title="Create a customer"
        description="Build a useful customer record now, then continue into vehicles, opportunities and service history."
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <ContactForm
          action={createContact}
          submitLabel="Create contact"
          users={users.map((user) => ({ id: user.id, name: user.name }))}
          variant="page"
        />

        <aside className="space-y-4 xl:sticky xl:top-6">
          <Surface className="relative overflow-hidden p-5">
            <div className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-primary/10 blur-3xl" />
            <SectionHeading
              title="What happens next"
              description="The new profile becomes the customer’s single relationship record."
            />
            <ol className="relative mt-5 space-y-5 before:absolute before:bottom-5 before:left-[17px] before:top-5 before:w-px before:bg-border">
              {nextSteps.map(({ icon: Icon, label, detail }, index) => (
                <li key={label} className="relative flex gap-3">
                  <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    <p className="text-sm font-medium text-foreground">{index + 1}. {label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Surface>

          <Surface className="p-5" inset>
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
                <CheckCircle2 className="size-4" />
              </span>
              <div>
                <p className="text-sm font-semibold text-foreground">Fast capture is fine</p>
                <p className="mt-0.5 text-xs text-muted-foreground">A name is enough to save.</p>
              </div>
            </div>
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              Duplicate detection checks the name, email and phone while you type. You can safely add more detail later.
            </p>
          </Surface>

          <Link href="/contacts" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
            Cancel and return
          </Link>
        </aside>
      </div>
    </div>
  );
}
