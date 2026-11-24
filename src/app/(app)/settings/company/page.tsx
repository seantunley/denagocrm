import { requireTenantOwner } from "@/lib/auth";
import { actingOwnerTenantId } from "@/lib/actingScope";
import { basePrisma } from "@/lib/db";
import { getCompanyProfile } from "@/lib/companyProfile";
import { saveCompanyProfile, saveRecordLabels } from "@/app/actions/company";
import { uploadMyLogoAction } from "@/app/actions/workspaceLogo";
import { resetMyLoginLookAction, saveMyLoginLookAction } from "@/app/actions/loginLook";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import LoginLookEditor from "@/components/branding/LoginLookEditor";
import { DEFAULT_RECORD_LABELS, isCustom, RECORD_KINDS } from "@/lib/recordLabels";
import { getRecordLabels } from "@/lib/recordLabelsServer";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { brandForTenant, brandLogoUrl } from "@/lib/tenantBrand";
import { parseLoginLook } from "@/lib/loginLook";

export const dynamic = "force-dynamic";

const FIELDS: { name: string; label: string; placeholder?: string; wide?: boolean }[] = [
  { name: "name", label: "Business name" },
  { name: "tagline", label: "Tagline", placeholder: "e.g. Family-owned since 1998" },
  { name: "phone", label: "Phone" },
  { name: "address", label: "Address", wide: true },
  { name: "email", label: "Email", placeholder: "hello@yourbusiness.co.za" },
  { name: "website", label: "Website", placeholder: "yourbusiness.co.za" },
  { name: "facebook", label: "Facebook", placeholder: "facebook.com/yourbusiness" },
  { name: "instagram", label: "Instagram", placeholder: "@yourbusiness" },
];

export default async function CompanyProfilePage() {
  await requireTenantOwner();
  const tenantId = await actingOwnerTenantId();
  const [profile, labels, brand, tenant] = await Promise.all([
    getCompanyProfile(),
    getRecordLabels(),
    brandForTenant(tenantId),
    basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { loginJson: true } }),
  ]);
  const logo = brandLogoUrl(brand) ?? (profile.logoUrl || null);

  return (
    <SettingsWorkspace
      current="company"
      title="Company profile"
      description="Your business details, logo and sign-in screen. They appear on your quotes, invoices, emails and other documents, and on the page your team signs in on."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-6">
        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <SaveForm action={saveCompanyProfile} success="Business details saved" resetOnSuccess={false} className="card space-y-4 p-5">
            <div>
              <h3 className="font-semibold">Business details</h3>
              <p className="mt-1 text-xs text-muted-foreground">Printed on your documents and emails. Leave a box empty if it doesn&apos;t apply.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {FIELDS.map((f) => (
                <label key={f.name} className={f.wide ? "space-y-1 sm:col-span-2 xl:col-span-3" : "space-y-1"}>
                  <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
                  <input name={f.name} defaultValue={profile[f.name as keyof typeof profile]} placeholder={f.placeholder} className="input" />
                </label>
              ))}
            </div>
            <div className="flex justify-end border-t border-border/60 pt-4">
              <SaveButton>Save business details</SaveButton>
            </div>
          </SaveForm>

          <SaveForm action={uploadMyLogoAction} success="Logo updated" className="card flex flex-col gap-4 p-5">
            <div>
              <h3 className="font-semibold">Logo</h3>
              <p className="mt-1 text-xs text-muted-foreground">Shown on your sign-in screen, in the app and on your documents.</p>
            </div>
            <div className="grid min-h-28 place-items-center rounded-xl border border-border bg-[#070909] p-4">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- an uploaded logo with no recorded size
                <img src={logo} alt={`${brand.displayName} logo`} className="max-h-20 w-auto object-contain" />
              ) : (
                <span className="text-xs text-slate-500">No logo yet</span>
              )}
            </div>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{logo ? "Replace with" : "Upload"}</span>
              <input type="file" name="logo" accept="image/png,image/jpeg,image/svg+xml,image/webp" required className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-foreground" />
              <span className="block text-[11px] text-muted-foreground">PNG, JPEG, SVG or WebP, under 1 MB. A transparent background looks best on the dark sign-in screen.</span>
            </label>
            <div className="mt-auto flex justify-end">
              <SaveButton>Upload logo</SaveButton>
            </div>
          </SaveForm>
        </section>

        <section className="space-y-3">
          <div>
            <h3 className="font-semibold">Sign-in screen</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The page your team signs in on. Change any of the wording, use your own background photo, and choose what goes in the card&apos;s place. Your logo, name and colour are used automatically.
            </p>
          </div>
          <LoginLookEditor
            action={saveMyLoginLookAction}
            resetAction={resetMyLoginLookAction}
            initial={parseLoginLook(tenant?.loginJson)}
            tenantId={tenantId}
            displayName={brand.displayName}
            tagline={brand.tagline}
            logoUrl={brandLogoUrl(brand)}
          />
        </section>

        <SaveForm action={saveRecordLabels} resetOnSuccess={false} className="card space-y-4 p-5">
          <div>
            <h3 className="font-semibold">Names for records</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              What your business calls these, e.g. Enquiry, Matter or Work order. Used in the menu, page titles and buttons.
              The assistant, help guides, documents and emails keep the standard words. Leave a box blank for the standard word.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-2 font-semibold">Standard</th>
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
      </div>
    </SettingsWorkspace>
  );
}
