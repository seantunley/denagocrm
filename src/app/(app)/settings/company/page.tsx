import { requireTenantOwner } from "@/lib/auth";
import { getCompanyProfile } from "@/lib/companyProfile";
import { saveCompanyProfile, saveRecordLabels } from "@/app/actions/company";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import { DEFAULT_RECORD_LABELS, isCustom, RECORD_KINDS } from "@/lib/recordLabels";
import { getRecordLabels } from "@/lib/recordLabelsServer";
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
  await requireTenantOwner();
  const [profile, labels] = await Promise.all([getCompanyProfile(), getRecordLabels()]);

  return (
    <SettingsWorkspace
      current="company"
      title="Company profile"
      description="Your business details — the single source of truth for the {{company.*}} merge fields and the branded footer in documents that use them (the Document Builder, e-signature documents and Document Studio). The built-in quote/invoice/agreement print templates are being migrated to read from here."
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

      <SaveForm action={saveRecordLabels} resetOnSuccess={false} className="card mt-4 max-w-2xl space-y-4 p-5">
        <div>
          <h3 className="font-semibold">Names for records</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            What your business calls these, e.g. Enquiry, Matter or Work order. Used in the menu, page titles and buttons.
            DAX, help articles, documents and emails keep the built-in words. Leave a box blank for the built-in word.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 font-semibold">Built in</th>
              <th className="py-2 font-semibold">One</th>
              <th className="py-2 font-semibold">Many</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {RECORD_KINDS.map((kind) => (
              <tr key={kind}>
                <td className="py-2 pr-3 text-muted-foreground">{DEFAULT_RECORD_LABELS[kind].one}</td>
                <td className="py-2 pr-3">
                  <input name={`${kind}_one`} maxLength={30} className="input" defaultValue={isCustom(labels, kind) ? labels[kind].one : ""} placeholder={DEFAULT_RECORD_LABELS[kind].one} aria-label={`${DEFAULT_RECORD_LABELS[kind].one}, one`} />
                </td>
                <td className="py-2">
                  <input name={`${kind}_many`} maxLength={30} className="input" defaultValue={isCustom(labels, kind) ? labels[kind].many : ""} placeholder={DEFAULT_RECORD_LABELS[kind].many} aria-label={`${DEFAULT_RECORD_LABELS[kind].many}, many`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end border-t border-border/60 pt-4">
          <SaveButton>Save names</SaveButton>
        </div>
      </SaveForm>
    </SettingsWorkspace>
  );
}
