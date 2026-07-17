import Link from "next/link";
import { ArrowLeft, MapPin, Palette, Plus, ShieldCheck, Trash2, Warehouse } from "lucide-react";
import { addStockLocation } from "@/app/actions/stock";
import { addStockStatus, removeStockStatus } from "@/app/actions/stockStatuses";
import { getStockLocations } from "@/lib/stockPlatform";
import { getStockStatuses } from "@/lib/stockStatuses";
import { requirePermission } from "@/lib/permissions";
import { PageHeader } from "@/components/page-header";
import { FeedbackBanner, SectionHeading, Surface } from "@/components/visual-system";

export default async function StockSettingsPage() {
  await requirePermission("stock.manage");
  const [locations, statuses] = await Promise.all([getStockLocations(), getStockStatuses()]);
  const systemStatuses = statuses.filter((status) => status.system);
  const customStatuses = statuses.filter((status) => !status.system);

  return (
    <div className="denago-workspace space-y-6">
      <Link href="/stock" className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to stock
      </Link>
      <PageHeader
        title="Stock settings"
        description="Manage physical inventory locations and optional organisational labels without weakening the controlled stock lifecycle."
      />

      <FeedbackBanner tone="info" title="Operational states are protected">
        Incoming, Available, Reserved, Allocated, PDI, Ready, Sold and Delivered drive system behaviour and cannot be removed. Custom labels are for non-committed stock such as demo preparation, photography or management review.
      </FeedbackBanner>

      <div className="grid gap-5 xl:grid-cols-2">
        <Surface className="p-5">
          <SectionHeading
            title="Stock locations"
            description="Showrooms, receiving yards, warehouses, demo fleets and consignment sites."
            action={<Warehouse className="size-5 text-primary" />}
          />
          <div className="mt-5 space-y-3">
            {locations.map((location) => (
              <div key={location.id} className="flex items-start gap-3 rounded-2xl border border-border bg-background/30 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground"><MapPin className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-foreground">{location.name}</p>
                    {location.isDefault && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Default intake</span>}
                  </div>
                  <p className="mt-1 text-xs capitalize text-muted-foreground">{location.type}{location.address ? ` · ${location.address}` : ""}</p>
                </div>
              </div>
            ))}
          </div>
          <form action={addStockLocation} className="mt-5 space-y-3 rounded-2xl border border-dashed border-border bg-background/20 p-4">
            <div className="flex items-center gap-2"><Plus className="size-4 text-primary" /><p className="font-semibold text-foreground">Add location</p></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div><label className="label">Name *</label><input name="name" className="input" required placeholder="e.g. Winelands showroom" /></div>
              <div><label className="label">Type</label><select name="type" className="input" defaultValue="showroom"><option value="showroom">Showroom</option><option value="yard">Receiving yard</option><option value="warehouse">Warehouse</option><option value="demo">Demo fleet</option><option value="consignment">Consignment</option></select></div>
            </div>
            <div><label className="label">Address / context</label><input name="address" className="input" /></div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" name="isDefault" /> Use as the default floor-stock intake location</label>
            <button className="btn-primary"><MapPin className="size-4" /> Create location</button>
          </form>
        </Surface>

        <Surface className="p-5">
          <SectionHeading
            title="Custom organisational labels"
            description="Optional holding labels for units outside a committed customer workflow."
            action={<Palette className="size-5 text-primary" />}
          />
          <div className="mt-5 space-y-3">
            {customStatuses.map((status) => (
              <div key={status.slug} className="flex items-center gap-3 rounded-2xl border border-border bg-background/30 p-4">
                <span className="size-4 shrink-0 rounded-full ring-4 ring-background" style={{ backgroundColor: status.color }} />
                <div className="min-w-0 flex-1"><p className="font-semibold text-foreground">{status.label}</p><p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{status.slug}</p></div>
                <form action={removeStockStatus.bind(null, status.slug)}><button className="grid size-8 place-items-center rounded-lg border border-red-400/20 text-red-300 transition-colors hover:bg-red-400/10" title={`Remove ${status.label}`}><Trash2 className="size-4" /></button></form>
              </div>
            ))}
            {customStatuses.length === 0 && <p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No custom labels have been added.</p>}
          </div>
          <form action={addStockStatus} className="mt-5 space-y-3 rounded-2xl border border-dashed border-border bg-background/20 p-4">
            <div className="flex items-center gap-2"><Plus className="size-4 text-primary" /><p className="font-semibold text-foreground">Add custom label</p></div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
              <div><label className="label">Label *</label><input name="label" className="input" required placeholder="e.g. Photography queue" /></div>
              <div><label className="label">Colour</label><input name="color" type="color" className="input h-11 p-1" defaultValue="#8b5cf6" /></div>
            </div>
            <button className="btn-primary"><Palette className="size-4" /> Add label</button>
          </form>
        </Surface>
      </div>

      <Surface className="p-5" inset>
        <SectionHeading title="Protected operational workflow" description="These statuses power stock availability, reservations, PDI, delivery gating and reporting." action={<ShieldCheck className="size-5 text-emerald-300" />} />
        <div className="mt-4 flex flex-wrap gap-2">
          {systemStatuses.map((status) => (
            <span key={status.slug} className="rounded-full border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: `${status.color}55`, backgroundColor: `${status.color}18`, color: status.color }}>{status.label}</span>
          ))}
        </div>
      </Surface>
    </div>
  );
}
