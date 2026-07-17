import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { ArrowLeft, BatteryCharging, Fingerprint, MapPin, Package } from "lucide-react";
import { getStockUnitDetail } from "@/lib/stockPlatform";
import { requireAnyPermission } from "@/lib/permissions";
import PrintPageButton from "@/components/PrintPageButton";

export default async function StockLabelPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAnyPermission("stock.view", "stock.manage");
  const { id } = await params;
  const unit = await getStockUnitDetail(id);
  if (!unit) notFound();
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const url = `${protocol}://${host}/stock/${id}`;
  const qr = await QRCode.toDataURL(url, { width: 600, margin: 1, errorCorrectionLevel: "M" });

  return (
    <div className="min-h-screen bg-background px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-3xl space-y-4 print:max-w-none print:space-y-0">
        <div className="flex items-center justify-between gap-3 print:hidden">
          <Link href={`/stock/${id}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Back to unit</Link>
          <PrintPageButton label="Print stock label" />
        </div>

        <div className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl print:rounded-none print:border-2 print:border-black print:bg-white print:shadow-none">
          <div className="flex items-center justify-between gap-4 border-b border-border bg-primary px-7 py-5 text-primary-foreground print:border-black print:bg-black print:text-white">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] opacity-80">Denago Cape Town</p>
              <h1 className="mt-1 text-3xl font-bold tracking-[-0.045em]">{unit.stockNumber ?? "STOCK UNIT"}</h1>
            </div>
            <Package className="size-10" />
          </div>
          <div className="grid gap-6 p-7 sm:grid-cols-[minmax(0,1fr)_15rem] print:grid-cols-[minmax(0,1fr)_15rem] print:text-black">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground print:text-neutral-600">Physical inventory unit</p>
              <h2 className="mt-2 text-4xl font-semibold tracking-[-0.05em] text-foreground print:text-black">{unit.productName}</h2>
              <p className="mt-2 text-lg text-muted-foreground print:text-neutral-700">{unit.color ?? "Colour not recorded"} · {unit.condition}</p>

              <dl className="mt-8 grid gap-3 sm:grid-cols-2 print:grid-cols-2">
                <div className="rounded-2xl border border-border bg-background/40 p-4 print:border-neutral-300 print:bg-white">
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground print:text-neutral-600"><Fingerprint className="size-4" /> Serial / VIN</dt>
                  <dd className="mt-2 break-all font-mono text-lg font-semibold text-foreground print:text-black">{unit.serial ?? "PENDING"}</dd>
                </div>
                <div className="rounded-2xl border border-border bg-background/40 p-4 print:border-neutral-300 print:bg-white">
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground print:text-neutral-600"><MapPin className="size-4" /> Location</dt>
                  <dd className="mt-2 text-lg font-semibold text-foreground print:text-black">{unit.locationName ?? "Unassigned"}</dd>
                </div>
                <div className="rounded-2xl border border-border bg-background/40 p-4 print:border-neutral-300 print:bg-white sm:col-span-2 print:col-span-2">
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground print:text-neutral-600"><BatteryCharging className="size-4" /> Battery / charger</dt>
                  <dd className="mt-2 text-sm font-medium text-foreground print:text-black">{unit.batteryType ?? "Battery type not recorded"}{unit.batterySerial ? ` · battery ${unit.batterySerial}` : ""}{unit.chargerSerial ? ` · charger ${unit.chargerSerial}` : ""}</dd>
                </div>
              </dl>
            </div>
            <div className="flex flex-col items-center justify-center rounded-3xl border border-border bg-white p-4 print:border-neutral-300">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt={`QR code for ${unit.stockNumber ?? unit.productName}`} className="w-full" />
              <p className="mt-2 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">Scan to open live stock record</p>
            </div>
          </div>
          <div className="border-t border-border px-7 py-4 text-xs text-muted-foreground print:border-neutral-300 print:text-neutral-600">
            This label identifies one physical inventory unit. Status, ownership, reservation, PDI and movement history remain controlled in DenagoCRM.
          </div>
        </div>
      </div>
    </div>
  );
}
