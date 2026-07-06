type ContactDefaults = {
  isCompany?: boolean;
  firstName?: string;
  lastName?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  address?: string | null;
  suburb?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  source?: string | null;
  notes?: string | null;
  tags?: string;
  ownerId?: string | null;
};

export default function ContactForm({
  action,
  defaults = {},
  submitLabel,
  users = [],
}: {
  action: (formData: FormData) => Promise<void>;
  defaults?: ContactDefaults;
  submitLabel: string;
  users?: { id: string; name: string }[];
}) {
  return (
    <form action={action} className="card space-y-4 max-w-2xl">
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="label">First name / Name *</label>
          <input name="firstName" className="input" required defaultValue={defaults.firstName ?? ""} />
        </div>
        <div>
          <label className="label">Last name</label>
          <input name="lastName" className="input" defaultValue={defaults.lastName ?? ""} />
        </div>
        <div>
          <label className="label">Company</label>
          <input name="company" className="input" defaultValue={defaults.company ?? ""} />
        </div>
        <div className="flex items-center gap-2 pt-5">
          <input
            type="checkbox"
            name="isCompany"
            id="isCompany"
            defaultChecked={defaults.isCompany ?? false}
            className="h-4 w-4"
          />
          <label htmlFor="isCompany" className="text-sm text-slate-400">
            This is a company / fleet account
          </label>
        </div>
        <div>
          <label className="label">Email</label>
          <input name="email" type="email" className="input" defaultValue={defaults.email ?? ""} />
        </div>
        <div>
          <label className="label">Phone</label>
          <input name="phone" className="input" defaultValue={defaults.phone ?? ""} />
        </div>
        <div>
          <label className="label">WhatsApp</label>
          <input name="whatsapp" className="input" defaultValue={defaults.whatsapp ?? ""} />
        </div>
        {users.length > 0 && (
          <div>
            <label className="label">Responsible / owner</label>
            <select name="ownerId" className="input" defaultValue={defaults.ownerId ?? ""}>
              <option value="">— unassigned —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label">Source</label>
          <select name="source" className="input" defaultValue={defaults.source ?? ""}>
            <option value="">—</option>
            <option value="manual">Manual</option>
            <option value="facebook">Facebook</option>
            <option value="instagram">Instagram</option>
            <option value="website">Website</option>
            <option value="referral">Referral</option>
            <option value="walk-in">Walk-in</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="label">Street address / estate &amp; unit</label>
          <input
            name="address"
            className="input"
            defaultValue={defaults.address ?? ""}
            placeholder="e.g. 12 Fairway Drive, De Zalze Golf Estate"
          />
        </div>
        <div>
          <label className="label">Suburb</label>
          <input name="suburb" className="input" defaultValue={defaults.suburb ?? ""} />
        </div>
        <div>
          <label className="label">City / town</label>
          <input name="city" className="input" defaultValue={defaults.city ?? ""} />
        </div>
        <div>
          <label className="label">Province</label>
          <select name="province" className="input" defaultValue={defaults.province ?? ""}>
            <option value="">—</option>
            <option>Western Cape</option>
            <option>Eastern Cape</option>
            <option>Northern Cape</option>
            <option>Gauteng</option>
            <option>KwaZulu-Natal</option>
            <option>Free State</option>
            <option>North West</option>
            <option>Limpopo</option>
            <option>Mpumalanga</option>
          </select>
        </div>
        <div>
          <label className="label">Postal code</label>
          <input name="postalCode" className="input" defaultValue={defaults.postalCode ?? ""} />
        </div>
      </div>
      <div>
        <label className="label">Tags (comma-separated)</label>
        <input
          name="tags"
          className="input"
          defaultValue={defaults.tags ?? ""}
          placeholder="VIP, Estate, Fleet, Golf club…"
        />
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea name="notes" className="input" rows={3} defaultValue={defaults.notes ?? ""} />
      </div>
      <button className="btn-primary">{submitLabel}</button>
    </form>
  );
}
