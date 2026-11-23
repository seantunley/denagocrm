/**
 * How far a panel's photo turns toward the pointer (components/PointerTilt.tsx).
 * Pure, so the arithmetic is tested without a browser.
 *
 * x is the turn about the horizontal axis (pointer low → top leans back), y
 * about the vertical one (pointer right → right side leans away). Both are in
 * degrees, at most `max` at the panel's edge, and 0 for a panel with no size
 * or a pointer that is not over it.
 */
export function tiltFromPointer(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  max: number,
): { x: number; y: number } {
  if (!(rect.width > 0 && rect.height > 0) || !(max > 0)) return { x: 0, y: 0 };
  const clamp = (n: number) => Math.min(0.5, Math.max(-0.5, n));
  const across = clamp((clientX - rect.left) / rect.width - 0.5);
  const down = clamp((clientY - rect.top) / rect.height - 0.5);
  const round = (n: number) => Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0
  return { x: round(-down * 2 * max), y: round(across * 2 * max) };
}
