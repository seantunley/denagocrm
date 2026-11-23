"use client";

import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { tiltFromPointer } from "@/lib/pointerTilt";

/**
 * A panel whose `[data-tilt-target]` follows the mouse by a few degrees — the
 * vehicle photo on a deal (the canvas board "Depth — showcase and sign-in").
 *
 * The handlers sit on the WHOLE panel, not the photo, because the photo is
 * usually under gradients and text that would swallow the pointer. Only a
 * mouse moves it: touch and pen are ignored here, and the `depth-tilt` CSS
 * applies the transform only for a fine pointer with motion allowed, so on a
 * phone or with reduced motion the photo simply stays still.
 *
 * Writes two CSS variables in an animation frame; React never re-renders.
 */
export default function PointerTilt({
  children,
  className,
  maxDegrees = 3,
}: {
  children: ReactNode;
  className?: string;
  /** The most the photo turns at the panel's edge. */
  maxDegrees?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const frame = useRef(0);

  function set(x: string, y: string) {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      panel.current?.style.setProperty("--tilt-x", x);
      panel.current?.style.setProperty("--tilt-y", y);
    });
  }

  return (
    <div
      ref={panel}
      className={cn("depth-tilt", className)}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse" || !panel.current) return;
        const tilt = tiltFromPointer(panel.current.getBoundingClientRect(), event.clientX, event.clientY, maxDegrees);
        set(`${tilt.x}deg`, `${tilt.y}deg`);
      }}
      onPointerLeave={() => set("0deg", "0deg")}
    >
      {children}
    </div>
  );
}
