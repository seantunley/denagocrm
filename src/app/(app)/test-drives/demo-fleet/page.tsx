import Link from "next/link";
import { BatteryCharging, CarFront, Gauge, Plus, Wrench } from "lucide-react";
import { prisma } from "@/lib/db";
import { hasPermission, requireAnyPermission } from "@/lib/permissions";
import { createDemoVehicle, updateDemoVehicle } from "@/app/actions/testDrives";
import ModalTrigger from "@/components/Modal";
import { PageHeader } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState, MetricCard, Surface } from "@/components/visual-system";

export const dynamic = "force-dynamic";

const statusClass: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300",
  maintenance: "bg-amber-500/15 text-amber-300",
  unavailable: "bg-red-500/15 text-red-300",
  retired: "bg-muted text-muted-foreground",
};

export default async function DemoFleetPage() {
  const user = await requireAnyPermission("activities.view", "activities.manage");
  const canManage = await hasPermission(user, "vehicles.manage");
  const now = new Date();
  const [demos, products, stockUnits] = await Promise.all([
    prisma.demoVehicle.findMany({
      where: { deletedAt: null },
      include: {
        bookings: {
          where: { deletedAt: null, status: { in: ["booked", "confirmed", "checked_out"] }, expectedReturnAt: { gte: now } },
          orderBy: { scheduledStart: "asc" },
          take: 5,
        },
      },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
    prisma.product.findMany({ where: { deletedAt: null, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.stockUnit.findMany({
      where: { deletedAt: null, status: { in: ["available", "reserved"] } },
      include: { product: { select: { name: true } } },
      orderBy: { stockNumber: "asc" },
      take: 500,
    }),
  ]);
  const productMap = new Map(products.map((product) => [product.id, product.name]));
  const active = demos.filter((demo) => demo.status === "active").length;
  const maintenance = demos.filter((demo) => demo.status === "maintenance").length;
  const outNow = demos.filter((demo) => demo.bookings.some((booking) => booking.status === "checked_out")).length;
  const averageBattery = demos.filter((demo) => demo.batteryLevelPct != null).length
    ? Math.round(demos.reduce((sum, demo) => sum + (demo.batteryLevelPct ?? 0), 0) / demos.filter((demo) => demo.batteryLevelPct != null).length)
    : 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Demo fleet" description="Control availability, odometer, battery state and upcoming bookings for dealership demo vehicles.">
        <Link href="/test-drives" className={buttonVariants({ variant: "secondary", size: "sm" })}>Test drives</Link>
        {canManage && (
          <ModalTrigger label={<><Plus className="size-4" />Add demo vehicle</>} title="Add demo vehicle" buttonClass={buttonVariants({ size: "sm" })}>
            <form action={createDemoVehicle} className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><label className="label">Display name</label><input name="name" className="input" required placeholder="Rover XL Demo 1" /></div>
              <div><label className="label">Product / model</label><select name="productId" className="input" defaultValue=""><option value="">No catalogue link</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></div>
              <div><label className="label">Stock unit</label><select name="stockUnitId" className="input" defaultValue=""><option value="">No stock-unit link</option>{stockUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.stockNumber ?? unit.serial ?? "Unit"} · {unit.product.name}</option>)}</select></div>
              <div><label className="label">VIN / serial</label><input name="vin" className="input" /></div>
              <div><label className="label">Registration</label><input name="regNumber" className="input" /></div>
              <div><label className="label">Colour</label><input name="color" className="input" /></div>
              <div><label className="label">Branch</label><input name="branch" className="input" /></div>
              <div><label className="label">Odometer (km)</label><input type="number" min="0" name="odometerKm" className="input" defaultValue="0" /></div>
              <div><label className="label">Battery (%)</label><input type="number" min="0" max="100" name="batteryLevelPct" className="input" /></div>
              <div className="sm:col-span-2"><label className="label">Notes</label><textarea name="notes" className="input" rows={3} /></div>
              <div className="sm:col-span-2"><button className="btn-primary w-full">Add to demo fleet</button></div>
            </form>
          </ModalTrigger>
        )}
      </PageHeader>

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard icon={CarFront} label="Active" value={active} detail={`${demos.length} total demo vehicles`} />
        <MetricCard icon={Gauge} label="Out now" value={outNow} detail="Currently checked out" accent={outNow > 0} />
        <MetricCard icon={Wrench} label="Maintenance" value={maintenance} detail="Unavailable for booking" accent={maintenance > 0} />
        <MetricCard icon={BatteryCharging} label="Average battery" value={`${averageBattery}%`} detail="Across recorded vehicles" />
      </section>

      {demos.length === 0 ? (
        <EmptyState icon={CarFront} title="No demo vehicles yet" description="Add dealership vehicles before assigning them to test-drive bookings." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {demos.map((demo) => {
            const next = demo.bookings[0];
            const checkedOut = demo.bookings.find((booking) => booking.status === "checked_out");
            return (
              <Surface key={demo.id} className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">{demo.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{productMap.get(demo.productId ?? "") ?? demo.vin ?? "No model linked"}{demo.regNumber ? ` · ${demo.regNumber}` : ""}</p>
                  </div>
                  <span className={`badge ${statusClass[demo.status] ?? "bg-muted text-muted-foreground"}`}>{demo.status}</span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  <div><p className="text-xs text-muted-foreground">Branch</p><p>{demo.branch ?? "Unassigned"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Odometer</p><p>{demo.odometerKm.toLocaleString("en-ZA")} km</p></div>
                  <div><p className="text-xs text-muted-foreground">Battery</p><p>{demo.batteryLevelPct ?? "—"}%</p></div>
                  <div><p className="text-xs text-muted-foreground">Bookings</p><p>{demo.bookings.length} upcoming</p></div>
                </div>
                <div className={`mt-4 rounded-xl border p-3 text-sm ${checkedOut ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-background/30"}`}>
                  {checkedOut ? (
                    <p><span className="font-medium text-amber-300">Out on test drive</span> · <Link href={`/test-drives/${checkedOut.id}`} className="text-primary hover:underline">{checkedOut.reference}</Link></p>
                  ) : next ? (
                    <p>Next: <Link href={`/test-drives/${next.id}`} className="font-medium text-primary hover:underline">{next.reference}</Link> · {next.scheduledStart.toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</p>
                  ) : <p className="text-muted-foreground">No upcoming bookings.</p>}
                </div>
                {canManage && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-sm text-primary">Edit vehicle</summary>
                    <form action={updateDemoVehicle.bind(null, demo.id)} className="mt-3 grid gap-2 sm:grid-cols-2">
                      <input name="name" className="input" required defaultValue={demo.name} />
                      <select name="status" className="input" defaultValue={demo.status}><option value="active">Active</option><option value="maintenance">Maintenance</option><option value="unavailable">Unavailable</option><option value="retired">Retired</option></select>
                      <input name="branch" className="input" defaultValue={demo.branch ?? ""} placeholder="Branch" />
                      <input name="regNumber" className="input" defaultValue={demo.regNumber ?? ""} placeholder="Registration" />
                      <input name="color" className="input" defaultValue={demo.color ?? ""} placeholder="Colour" />
                      <input type="number" min="0" name="odometerKm" className="input" defaultValue={demo.odometerKm} />
                      <input type="number" min="0" max="100" name="batteryLevelPct" className="input" defaultValue={demo.batteryLevelPct ?? ""} placeholder="Battery %" />
                      <textarea name="notes" className="input sm:col-span-2" rows={2} defaultValue={demo.notes ?? ""} placeholder="Notes" />
                      <div className="sm:col-span-2 text-right"><button className="btn-secondary btn-sm">Save vehicle</button></div>
                    </form>
                  </details>
                )}
              </Surface>
            );
          })}
        </div>
      )}
    </div>
  );
}
