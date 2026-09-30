/**
 * Which vehicles a delivered quote still has to register — ONE ENTRY PER UNIT.
 *
 * ── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
 *
 * `markDelivered` redirected to `/vehicles/new` exactly once, no matter what was
 * sold. Q-1014 sold "Denago EV Rover XXL" with `qty: 2`; one vehicle was
 * registered and the second silently never existed — no service history, no
 * warranty identity, invisible in the customer's garage.
 *
 * ── WHY A LINKED PRODUCT IS THE TEST, AND NOT `kind` ────────────────────────
 *
 * `kind` cannot separate a vehicle from an accessory: "Trailer", "Rain Cover
 * Rover XL" and "Mounted Rear Basket" are all `kind: "product"`, exactly like the
 * cart. What actually distinguishes them in this data is whether the line points
 * at a catalogue Product.
 *
 * Checked against the only two real `qty > 1` lines in production, which is why
 * this rule and not a cleverer one:
 *
 *   Q-1014  "Denago EV Rover XXL"  qty 2  productId set   → 2 vehicles   ✅
 *   Q-1013  "Delivery"             qty 2  productId null  → 0 vehicles   ✅
 *
 * The second is a delivery FEE charged twice. A rule based on `qty` alone would
 * have asked somebody to register two vehicles called "Delivery".
 *
 * A free-text line cannot produce a useful Vehicle anyway: there is no product to
 * hang colours, service intervals or warranty terms off, and `model` would be
 * whatever prose the salesperson typed. Those keep today's behaviour — the
 * delivery finishes and nothing is queued.
 */

export type DeliveryQuoteLine = {
  productId: string | null;
  description: string;
  qty: number;
  kind: string;
  optional: boolean;
  selected: boolean;
  colorPreference: string | null;
  product?: { name: string } | null;
};

export type VehicleToRegister = {
  productId: string;
  /** The catalogue name, falling back to the line's own wording. */
  model: string;
  /** The colour agreed on the line, where one was chosen. */
  color: string;
};

/** Stock statuses that mean the unit has been handed over (and has its vehicle). */
export const DELIVERED_STOCK_STATUSES = ["delivered", "sold"] as const;

/**
 * What to do with a live vehicle that already carries a delivered cart's VIN.
 *
 *   same customer as the quote → reuse it (the one-vehicle-per-cart rule)
 *   no customer on it          → attach it to the quote's customer (audited)
 *   a DIFFERENT customer       → refuse the whole delivery; never reassign
 *
 * Reusing without this check handed a cart to one customer while its vehicle
 * record — service history, warranty identity — stayed on somebody else.
 */
export type VinMatch = "reuse" | "attach" | "conflict";

export function vinMatch(vehicleContactId: string | null, quoteContactId: string): VinMatch {
  if (!vehicleContactId) return "attach";
  return vehicleContactId === quoteContactId ? "reuse" : "conflict";
}

/** Last 4 of the VIN only — never the other customer's name or details. */
export function vinConflictMessage(serial: string): string {
  return `Cart …${serial.slice(-4)} is already registered to another customer — check the stock unit or transfer the vehicle first. Nothing was changed.`;
}

/** The only stock status a cart can be handed over from: PDI passed. */
export const DELIVERABLE_STATUS = "ready_for_delivery";

const NOT_READY_REASON: Record<string, string> = {
  allocated: "PDI not started",
  pdi: "still in PDI",
  hold: "on hold",
  damaged: "marked damaged",
};

/**
 * Why a delivery is refused: each cart that is not ready, and the reason. Named
 * by stock number, else the last 4 of its serial — never the customer.
 */
export function notReadyMessage(
  quoteNumber: number,
  units: readonly { stockNumber: string | null; serial: string | null; status: string }[],
): string {
  const list = units
    .map((unit) => {
      const name = unit.stockNumber ?? (unit.serial ? `unit …${unit.serial.slice(-4)}` : "an unnumbered unit");
      return `${name} (${NOT_READY_REASON[unit.status] ?? unit.status.replaceAll("_", " ")})`;
    })
    .join(", ");
  return `Q-${quoteNumber} can't be delivered yet — ${units.length === 1 ? "this cart is" : "these carts are"} not ready: ${list}. Complete PDI (or resolve the hold) on the stock page first. Nothing was changed.`;
}

/**
 * Expand a delivered quote's lines into one entry per physical vehicle.
 *
 * EXPANDED, not counted. The caller walks the customer through registrations one
 * at a time, and two units of different models must preselect different products
 * — a bare count could not express that.
 *
 * `fromStock` — the quote's stock units that are already delivered. Each one got
 * its vehicle record automatically at delivery (lib/quoteDelivery.ts), so it is
 * taken off the queue, one entry per unit of the same product. Without this the
 * customer was asked to register a cart the stock flow had already created, and
 * ended up with two vehicle records for one cart.
 */
export function vehiclesAwaitingRegistration(
  lines: DeliveryQuoteLine[],
  fromStock: readonly { productId: string }[] = [],
): VehicleToRegister[] {
  const covered = new Map<string, number>();
  for (const unit of fromStock) covered.set(unit.productId, (covered.get(unit.productId) ?? 0) + 1);
  const queue: VehicleToRegister[] = [];
  for (const line of lines) {
    if (!line.productId) continue;
    // A trade-in is a vehicle arriving FROM the customer, not one being handed to
    // them. It is not part of this delivery's registrations.
    if (line.kind === "trade_in") continue;
    // An optional line the customer did not take was never sold.
    if (line.optional && !line.selected) continue;
    // `qty` is a Float on the model, so a fractional quantity is expressible even
    // though a fraction of a vehicle is not. Whole units only, and at least one:
    // a line that exists was sold at least once.
    const units = Math.max(1, Math.floor(line.qty));
    for (let i = 0; i < units; i++) {
      const left = covered.get(line.productId) ?? 0;
      if (left > 0) {
        covered.set(line.productId, left - 1);
        continue;
      }
      queue.push({
        productId: line.productId,
        model: line.product?.name ?? line.description,
        color: line.colorPreference ?? "",
      });
    }
  }
  return queue;
}
