import { VENDOR_KINDS } from "@/lib/vendors";

type VendorDetails = {
  name: string;
  kind: string;
  vatNumber: string | null;
  registrationNumber: string | null;
  address: string | null;
  paymentTerms: string | null;
  paymentReference: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
};

/** The supplier form's fields (Settings → Suppliers: add, edit). No banking details — Sean: "No". */
export default function VendorFields({ vendor }: { vendor?: VendorDetails }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div><label className="label">Name</label><input name="name" className="input" required maxLength={120} defaultValue={vendor?.name} placeholder="Denago, Cape Carts Transport, Wrap Studio" /></div>
        <div>
          <label className="label">What they are</label>
          <select name="kind" className="input" defaultValue={vendor?.kind ?? "other"}>
            {VENDOR_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label className="label">Phone</label><input name="phone" className="input" maxLength={40} defaultValue={vendor?.phone ?? ""} /></div>
        <div><label className="label">Email</label><input name="email" type="email" className="input" maxLength={160} defaultValue={vendor?.email ?? ""} /></div>
        <div><label className="label">VAT number</label><input name="vatNumber" className="input" maxLength={40} defaultValue={vendor?.vatNumber ?? ""} /></div>
        <div><label className="label">Registration number</label><input name="registrationNumber" className="input" maxLength={40} defaultValue={vendor?.registrationNumber ?? ""} /></div>
        <div><label className="label">Payment terms</label><input name="paymentTerms" className="input" maxLength={120} defaultValue={vendor?.paymentTerms ?? ""} placeholder="30 days from invoice" /></div>
        <div><label className="label">Payment reference</label><input name="paymentReference" className="input" maxLength={80} defaultValue={vendor?.paymentReference ?? ""} placeholder="What our payments to them quote" /></div>
      </div>
      <div><label className="label">Address</label><textarea name="address" className="input min-h-16" maxLength={400} defaultValue={vendor?.address ?? ""} /></div>
      <div><label className="label">Notes</label><textarea name="notes" className="input min-h-16" maxLength={1000} defaultValue={vendor?.notes ?? ""} /></div>
    </>
  );
}
