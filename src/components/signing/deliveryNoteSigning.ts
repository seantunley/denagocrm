/**
 * Where the customer's signature on a delivery note stands, as the delivery
 * screens need it — the server's answer (lib/deliveryNoteSigning.ts) reduced to
 * what a client component may be handed.
 *
 * `signed` is the customer's signature. `sealed` says whether the signed note
 * has finished being sealed and filed; the delivery can be completed either way.
 */
export type DeliveryNoteSigning =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "signed"; signedByName: string; sealed: boolean };

/** From the engine's state for the delivery's note. */
export function deliveryNoteSigning(
  state: { kind: "none" } | { kind: "open" } | { kind: "finishing"; signedByName: string } | { kind: "signed"; signedByName: string },
): DeliveryNoteSigning {
  if (state.kind === "finishing") return { kind: "signed", signedByName: state.signedByName, sealed: false };
  if (state.kind === "signed") return { kind: "signed", signedByName: state.signedByName, sealed: true };
  return { kind: state.kind };
}
