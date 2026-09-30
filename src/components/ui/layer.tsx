"use client";

import { useState, type ComponentProps } from "react";

/**
 * Whatever opens LAST sits on top — for every overlay in the app.
 *
 * Overlays each carried a fixed z-index: dialogs z-50, the quote editor z-[100],
 * hand-rolled ModalPortal overlays z-[60]/z-[70]. Something opened FROM inside a
 * higher one therefore rendered underneath it: "Countersign & review" in the
 * quote editor opened the signing preview (z-60) behind the quote (z-100), and
 * Sean saw nothing happen ("opened something in the background", 2026-09-30).
 * Fixed numbers can't be right for every nesting, so each overlay takes the next
 * layer number when it MOUNTS, i.e. when it opens. Everything inside keeps its
 * own z-index relative to its layer.
 *
 * Mounted inside each portal (Radix `Portal` children and ModalPortal), so it is
 * created at open time. Radix portals render their child `asChild`, so this
 * forwards the props and ref it is given onto its div.
 */
let top = 1000;

export function Layer({ style, ...props }: ComponentProps<"div">) {
  const [z] = useState(() => ++top);
  return <div {...props} style={{ ...style, position: "relative", zIndex: z }} />;
}
