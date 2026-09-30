import { updateProductShowcase } from "@/app/actions/products";
import { showcaseIconNames } from "@/lib/doceditor/model";
import { MAX_VEHICLE_SPECS, parseVehicleSpecs } from "@/lib/docbuilder/vehicleShowcase";
import { storedFileSrc } from "@/lib/storedFileSrc";

/**
 * "Quote showcase" card on the product page: what the showcase quotation layout
 * shows when this model is the vehicle being quoted. Server component — a plain
 * form posting to a server action.
 */
export default function ProductShowcaseForm({
  product,
}: {
  product: { id: string; name: string; showcaseTagline: string | null; showcaseSpecs: unknown; showcaseImageRef: string | null };
}) {
  const specs = parseVehicleSpecs(product.showcaseSpecs);
  const photo = storedFileSrc(product.showcaseImageRef);
  return (
    <form action={updateProductShowcase.bind(null, product.id)} className="card space-y-4 lg:col-span-2">
      <div>
        <h2 className="font-semibold">Quote showcase</h2>
        <p className="text-xs text-muted-foreground">
          Shown in the vehicle section of the showcase quotation whenever this model is the vehicle being quoted. The
          description above is used as the showcase description. Anything left empty is simply not shown.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className="label">Tagline (under the model name)</label>
            <input name="showcaseTagline" className="input" maxLength={120} defaultValue={product.showcaseTagline ?? ""} placeholder="e.g. Lifted 4-seater · Forward-facing" />
          </div>
          <div>
            <label className="label">Photo (PNG, JPG or WebP, up to 1.5 MB)</label>
            <p className="mb-1 text-[11px] leading-4 text-muted-foreground">
              <strong>Cut-out</strong> (cart on white or transparent): about 1200 × 1000 px, cart filling the frame. In the quote
              layout, set the vehicle section&apos;s Photo fit to &ldquo;Show whole photo&rdquo;.{" "}
              <strong>Scenic</strong> (cart in a landscape, fades into the page): 1400 × 1000 px landscape, cart in the right
              two-thirds; the left third sits behind the text, so keep only scenery there. Photo fit &ldquo;Fill&rdquo;.
            </p>
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt={product.name} className="mb-2 max-h-40 rounded border border-border bg-white object-contain" />
            ) : null}
            <input type="file" name="showcaseImage" accept="image/png,image/jpeg,image/webp" className="block w-full text-sm" />
            {photo ? (
              <label className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" name="removeShowcaseImage" className="h-4 w-4" /> Remove the current photo
              </label>
            ) : null}
          </div>
        </div>
        <div>
          <label className="label">Spec icons (up to {MAX_VEHICLE_SPECS})</label>
          <div className="space-y-2">
            {Array.from({ length: MAX_VEHICLE_SPECS }, (_, i) => (
              <div key={i} className="grid grid-cols-[7rem_1fr_1.4fr] gap-2">
                <select name={`specIcon${i}`} className="input" defaultValue={specs[i]?.icon ?? ["seats", "range", "electric", "premium"][i]}>
                  {showcaseIconNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <input name={`specLabel${i}`} className="input" maxLength={40} defaultValue={specs[i]?.label ?? ""} placeholder={["4 SEATS", "64 KM", "ELECTRIC", "PREMIUM"][i]} />
                <input name={`specSub${i}`} className="input" maxLength={60} defaultValue={specs[i]?.sub ?? ""} placeholder={["Comfortable seating", "Typical range (per charge)", "Quiet & emissions-free", "Stylish design and finish"][i]} />
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">A spec with an empty label is left out.</p>
        </div>
      </div>
      <button className="btn-primary">Save showcase</button>
    </form>
  );
}
