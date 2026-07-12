import { redirect } from "next/navigation";
import { basePrisma } from "@/lib/db";
import { getPortalContact } from "@/lib/portal";
import { PortalPreferenceForm, PortalProfileForm } from "@/components/PortalExpansionForms";
import { formatDate } from "@/lib/format";

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
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Profile & preferences</h1>
        <p className="text-sm text-slate-400 mt-1">Request changes to your CRM profile and control how Denago may contact you.</p>
      </div>
      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold">Your details</h2>
          <p className="text-xs text-slate-500 mt-1">Changes are reviewed before protected CRM records are updated.</p>
        </div>
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
      </section>
      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold">Communication preferences</h2>
          <p className="text-xs text-slate-500 mt-1">Marketing consent changes are recorded in the POPIA consent ledger.</p>
        </div>
        <PortalPreferenceForm defaults={defaults} />
      </section>
      {requests.length > 0 && (
        <section className="card">
          <h2 className="font-semibold mb-3">Recent profile requests</h2>
          <ul className="divide-y divide-slate-800">
            {requests.map((request) => (
              <li key={request.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                <span>{request.note || "Profile update"}</span>
                <span className="text-xs text-slate-400">{request.status} · {formatDate(request.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
