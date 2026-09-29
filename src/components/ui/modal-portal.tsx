"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Renders an overlay into `document.body`, so its z-index means what it says.
 *
 * ── WHY A HAND-ROLLED MODAL NEEDS THIS ──────────────────────────────────────
 *
 * `z-index` is not global. It orders siblings WITHIN a stacking context, and a
 * long list of ordinary CSS properties silently creates one: `transform`,
 * `filter`, `backdrop-filter`, `opacity` below 1, `will-change`, `contain`, and
 * a positioned ancestor with its own `z-index`.
 *
 * The app shell's top bar is `fixed … z-30 … backdrop-blur-xl`. A modal rendered
 * INLINE in the page tree therefore sits inside whatever context its ancestors
 * established, and `z-50` on it competes only with its siblings inside that box —
 * never with the bar. The bar wins, and the clock/weather strip paints straight
 * over the top of an open dialog.
 *
 * Raising the number does not fix it, which is why the ten hand-rolled overlays
 * this replaced had drifted to z-40, z-50, z-[60], z-[70] and z-[100]: each was
 * bumped until it looked right on one screen. None of them was competing with the
 * bar at all.
 *
 * A portal moves the DOM to `document.body`, into the ROOT stacking context,
 * where the numbers finally compare with each other and with the shared
 * `Dialog` — which never had the bug precisely because Radix portals it.
 *
 * ── WHAT IT DOES NOT CHANGE ─────────────────────────────────────────────────
 *
 * React events still bubble through the REACT tree, not the DOM tree, so an
 * `onPointerDown` backdrop close and any handler in an ancestor keep working.
 * State, context and theming are all unaffected for the same reason.
 *
 * The one thing that DOES change is HTML form association: a submit button
 * inside a portal is no longer inside an enclosing `<form>` element. Every
 * overlay converted here either has no form or carries its own inside the
 * portalled subtree, so nothing relied on that.
 *
 * ── SSR ─────────────────────────────────────────────────────────────────────
 *
 * `document` does not exist while rendering on the server, and rendering nothing
 * on the first client pass keeps the markup identical on both sides — a portal
 * emitted during hydration is a mismatch. An overlay is only ever visible after
 * an interaction, so there is nothing to lose by waiting a tick.
 *
 * `useSyncExternalStore` rather than the usual `useState` + `useEffect` mounted
 * flag: it answers the server snapshot during SSR and the client snapshot
 * afterwards, which is the same behaviour without setting state in an effect.
 * The store never changes, so `subscribe` has nothing to do.
 */
const NEVER_CHANGES = () => () => {};
const onClient = () => true;
const onServer = () => false;

export default function ModalPortal({ children }: { children: ReactNode }) {
  const hydrated = useSyncExternalStore(NEVER_CHANGES, onClient, onServer);
  if (!hydrated) return null;
  return createPortal(children, document.body);
}
