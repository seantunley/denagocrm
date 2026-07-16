import { requireOwner } from "@/lib/auth";
import { getCompanyProfile } from "@/lib/companyProfile";
import { saveCompanyProfile } from "@/app/actions/company";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const FIELDS: { name: string; label: string; placeholder?: string }[] = [
  { name: "name", label: "Company name" },
  { name: "tagline", label: "Tagline", placeholder: "Authorized Denago EV Dealer" },
  { name: "address", label: "Address" },
  { name: "phone", label: "Phone" },
  { name: "email", label: "Email" },
  { name: "website", label: "Website", placeholder: "denagocpt.co.za" },
  { name: "facebook", label: "Facebook", placeholder: "facebook.com/…" },
  { name: "instagram", label: "Instagram", placeholder: "@handle" },
  { name: "logoUrl", label: "Logo URL", placeholder: "https://…" },
];

export default async function CompanyProfilePage() {
  await requireOwner();
  const profile = await getCompanyProfile();

  return (
    <SettingsWorkspace
      current="company"
      title="Company profile"
      description="Your business details — the single source of truth for every document's branded footer and the {{company.*}} merge fields. Change them here and every quote, invoice and agreement updates."
      groups={SETTINGS_NAV_GROUPS}
    >
      <form action={saveCompanyProfile} className="card max-w-2xl space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.name} className={f.name === "address" ? "space-y-1 sm:col-span-2" : "space-y-1"}>
              <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
              <input
                name={f.name}
                defaultValue={profile[f.name as keyof typeof profile]}
                placeholder={f.placeholder}
                className="input"
              />
            </label>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
          <p className="text-[11px] text-muted-foreground">
            Blank fields fall back to the built-in defaults.
          </p>
          <Button type="submit">Save company profile</Button>
        </div>
      </form>
    </SettingsWorkspace>
  );
}
