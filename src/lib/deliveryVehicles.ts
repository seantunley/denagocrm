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

/**
 * Expand a delivered quote's lines into one entry per physical vehicle.
 *
 * EXPANDED, not counted. The caller walks the customer through registrations one
 * at a time, and two units of different models must preselect different products
 * — a bare count could not express that.
 */
export function vehiclesAwaitingRegistration(lines: DeliveryQuoteLine[]): VehicleToRegister[] {
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
      queue.push({
        productId: line.productId,
        model: line.product?.name ?? line.description,
        color: line.colorPreference ?? "",
      });
    }
  }
  return queue;
}
