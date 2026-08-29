import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { vehiclesAwaitingRegistration, type DeliveryQuoteLine } from "../src/lib/deliveryVehicles";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * A delivery registered ONE vehicle however many were sold.
 *
 * Q-1014 sold two Rover XXLs; one was registered and the second silently never
 * existed — no service history, no warranty identity, absent from the customer's
 * garage. The cases below are the real production rows, because the rule was
 * chosen to fit them rather than the other way round.
 */

const line = (over: Partial<DeliveryQuoteLine> = {}): DeliveryQuoteLine => ({
  productId: "prod_1",
  description: "Denago EV Rover XXL",
  qty: 1,
  kind: "product",
  optional: false,
  selected: true,
  colorPreference: null,
  product: { name: "Denago EV Rover XXL" },
  ...over,
});

test("two of the same cart queue TWO registrations", () => {
  // Q-1014 verbatim.
  const queue = vehiclesAwaitingRegistration([line({ qty: 2 })]);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.map((v) => v.productId), ["prod_1", "prod_1"]);
});

test("A FEE CHARGED TWICE IS NOT TWO VEHICLES", () => {
  // Q-1013 verbatim: "Delivery", qty 2, no linked product. Counting on `qty`
  // alone would have asked somebody to register two vehicles called "Delivery".
  const queue = vehiclesAwaitingRegistration([
    line({ description: "Delivery", qty: 2, productId: null, product: null }),
  ]);
  assert.deepEqual(queue, []);
});

test("accessories are not vehicles, and `kind` cannot tell you that", () => {
  // Every one of these is kind:"product" in production, exactly like the cart.
  // The linked product is what separates them.
  const queue = vehiclesAwaitingRegistration([
    line({ qty: 1 }),
    line({ description: "Trailer", productId: null, product: null }),
    line({ description: "Rain Cover Rover XL", productId: null, product: null }),
    line({ description: "Mounted Rear Basket and Tow Hitch", productId: null, product: null }),
  ]);
  assert.equal(queue.length, 1, "only the catalogue cart is a vehicle");
});

test("mixed models expand in order, each carrying its own product and colour", () => {
  // Why the queue is EXPANDED rather than counted: a bare number could not say
  // which product to preselect for the third registration.
  const queue = vehiclesAwaitingRegistration([
    line({ productId: "rover", product: { name: "Rover XL" }, qty: 2, colorPreference: "Black" }),
    line({ productId: "city", product: { name: "City Cart" }, qty: 1, colorPreference: "White" }),
  ]);
  assert.deepEqual(
    queue.map((v) => `${v.model}/${v.color}`),
    ["Rover XL/Black", "Rover XL/Black", "City Cart/White"],
  );
});

test("a trade-in is a vehicle coming IN, and is never queued", () => {
  const queue = vehiclesAwaitingRegistration([line({ kind: "trade_in", qty: 1 })]);
  assert.deepEqual(queue, []);
});

test("an optional line the customer declined was never sold", () => {
  assert.deepEqual(vehiclesAwaitingRegistration([line({ optional: true, selected: false })]), []);
  assert.equal(vehiclesAwaitingRegistration([line({ optional: true, selected: true })]).length, 1);
});

test("a fractional quantity still registers whole vehicles", () => {
  // qty is a Float on the model, so 1.5 is expressible even though half a cart
  // is not. A line that exists was sold at least once.
  assert.equal(vehiclesAwaitingRegistration([line({ qty: 1.5 })]).length, 1);
  assert.equal(vehiclesAwaitingRegistration([line({ qty: 2.9 })]).length, 2);
  assert.equal(vehiclesAwaitingRegistration([line({ qty: 0 })]).length, 1);
});

/* ── the wiring, which is what actually failed ───────────────────────────── */

test("the delivery hands the whole queue on, not just the first vehicle", () => {
  const fulfilment = src("src/app/actions/fulfilment.ts");
  assert.match(fulfilment, /vehiclesAwaitingRegistration/, "markDelivered must build the queue");
  assert.match(fulfilment, /seq=0/, "…and start it at the first vehicle");
});

test("registering one vehicle returns for the next until the queue is empty", () => {
  const vehicles = src("src/app/actions/vehicles.ts");
  assert.match(vehicles, /vehiclesAwaitingRegistration/);
  assert.match(vehicles, /seq=\$\{next\}/, "the next registration must carry the advanced position");
});
