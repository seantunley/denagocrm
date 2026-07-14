import { redirect } from "next/navigation";
import { BellRing, Clock3, UserRound } from "lucide-react";
import { basePrisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { PortalPreferenceForm, PortalProfileForm } from "@/components/PortalExpansionForms";
import { formatDate } from "@/lib/format";
import { PortalPageHeader, SectionHeading, StatusPill, Surface } from "@/components/visual-system";

type PreferenceRow = {
  serviceReminders: boolean;
  portalNotifications: boolean;
  marketingEmail: boolean;
  smsServiceUpdates: boolean;
};
type RequestRow = { id: string; status: string; createdAt: Date; note: string | null };

export default async function PortalProfilePage() {
  const contact = await getPortalContact();
  if (!contact) redirect("/portal/login");

  const [preferences, requests] = await Promise.all([
    basePrisma.$queryRaw<PreferenceRow[]>`
      SELECT "serviceReminders", "portalNotifications", "marketingEmail", "smsServiceUpdates"
      FROM "PortalPreference" WHERE "contactId" = ${contact.id}
    `,
    basePrisma.$queryRaw<RequestRow[]>`
      SELECT "id", "status", "createdAt", "note"
      FROM "PortalProfileChangeRequest"
      WHERE "contactId" = ${contact.id}
      ORDER BY "createdAt" DESC LIMIT 10
    `,
  ]);
  const defaults = preferences[0] ?? {
    serviceReminders: true,
    portalNotifications: true,
    marketingEmail: !contact.marketingOptOut,
    smsServiceUpdates: true,
  };

  return (
    <div className="space-y-10">
      <PortalPageHeader eyebrow="Your account" title="Profile & preferences" description="Keep your details current and choose how Denago may contact you about service, support and offers." />
      <Surface className="space-y-5 p-5 sm:p-6">
        <SectionHeading title="Your details" description="For your security, requested changes are reviewed before protected customer records are updated." action={<span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><UserRound className="size-5" /></span>} />
        <PortalProfileForm contact={{
          firstName: contact.firstName,
          lastName: contact.lastName,
          phone: contact.phone,
          whatsapp: contact.whatsapp,
          address: contact.address,
          suburb: contact.suburb,
          city: contact.city,
          province: contact.province,
          postalCode: contact.postalCode,
        }} />
      </Surface>
      <Surface className="space-y-5 p-5 sm:p-6">
        <SectionHeading title="Communication preferences" description="Marketing consent changes are recorded in the POPIA consent ledger." action={<span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary"><BellRing className="size-5" /></span>} />
        <PortalPreferenceForm defaults={defaults} />
      </Surface>
      {requests.length > 0 && (
        <Surface>
          <div className="border-b border-border px-5 py-4"><SectionHeading title="Recent profile requests" description="Updates currently being reviewed by our team." action={<Clock3 className="size-5 text-muted-foreground" />} /></div>
          <ul className="divide-y divide-border px-5">
            {requests.map((request) => (
              <li key={request.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                <span>{request.note || "Profile update"}</span>
                <div className="flex flex-wrap items-center justify-end gap-2"><StatusPill tone={request.status === "approved" ? "success" : request.status === "rejected" ? "danger" : "warning"}>{request.status}</StatusPill><span className="text-xs text-slate-400">{formatDate(request.createdAt)}</span></div>
              </li>
            ))}
          </ul>
        </Surface>
      )}
    </div>
  );
}
