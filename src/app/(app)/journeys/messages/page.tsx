import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireTenantOwner } from "@/lib/auth";
import { requireRoute } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import CustomerMessageEditors from "@/components/CustomerMessageEditors";
import EmailDesignCards from "@/components/EmailDesignCards";
import { emailKindsAt, MESSAGE_PLACES, messageEditorHref, messagePlace, textKindsAt } from "@/lib/customerMessagePlaces";
import { SIGNING_EMAILS, SIGNING_EMAIL_KINDS } from "@/lib/signing/emailTemplates";

export const dynamic = "force-dynamic";

/**
 * Journeys → Customer messages: the wording of everything the CRM sends a
 * customer by itself — service reminders, recalls, review requests, surveys —
 * next to the journeys that send them (Sean, 2026-10-07: these were "buried in
 * settings under email").
 *
 * Also the one index of EVERY customer message, wherever its editor lives, so
 * nothing a customer can receive is out of sight.
 *
 * Owner-only: the editors save through requireTenantOwner actions.
 */
export default async function CustomerMessagesPage({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  // The proxy's rule for /journeys, then the owner check the editors' actions apply.
  await requireRoute("/journeys");
  await requireTenantOwner();
  const { open } = await searchParams;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer messages"
        description="The emails and texts the CRM sends your customers by itself. Your logo, brand colour and company details are added for you; each preview shows exactly what the customer receives."
      >
        <Link href="/journeys" className="btn-secondary">
          <ArrowLeft className="size-4" />
          Journeys
        </Link>
      </PageHeader>

      <section className="card">
        <p className="mb-4 text-sm text-muted-foreground">
          Whether each one is sent at all is switched on Journeys and in{" "}
          <Link href="/settings/automatic" className="text-primary underline">Automatic jobs &amp; messages</Link>.
        </p>
        {/* Emails open in the document editor; texts stay text. */}
        <EmailDesignCards kinds={emailKindsAt("automatic")} frame />
        <div className="mt-4">
          <CustomerMessageEditors kinds={textKindsAt("automatic")} open={open} />
        </div>
      </section>

      <section className="card">
        <h2 className="font-semibold">All customer messages</h2>
        <p className="mb-3 text-sm text-muted-foreground">Every message a customer can receive, and where its wording is edited.</p>
        <ul className="divide-y divide-border">
          {SIGNING_EMAIL_KINDS.map((kind) => {
            const def = SIGNING_EMAILS[kind];
            return (
              <li key={kind} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {def.label}
                  <span className="ml-2 badge bg-muted text-muted-foreground">
                    {def.channel === "sms" ? "SMS" : def.channel === "whatsapp" ? "WhatsApp" : "Email"}
                  </span>
                </span>
                <Link href={messageEditorHref(kind)} className="text-primary underline">
                  {MESSAGE_PLACES[messagePlace(kind)].label}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
