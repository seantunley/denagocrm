/**
 * The sign-in screen's background on phones and tablets: three still planes at
 * three heights behind the form, drifting very slowly (the canvas board
 * "Depth — showcase and sign-in"). Desktop already has its own scene beside
 * the form (BrandScene), so these stop at `lg`.
 *
 * Pure decoration: hidden from assistive technology and from the pointer, and
 * the drift (the `depth-plane` utility in app/depth.css) stops with reduced
 * motion. Each plane's angle, path and pace are CSS variables, so they never
 * move in step.
 */
import type { CSSProperties } from "react";

const PLANES = [
  { className: "-left-24 top-16 h-72 w-80 rounded-[40px] bg-[oklch(0.135_0.004_200)]", vars: { "--plane-rotate": "-8deg", "--plane-dx": "14px", "--plane-dy": "-10px", "--plane-duration": "46s" } },
  { className: "-right-28 bottom-10 h-80 w-96 rounded-[48px] bg-[oklch(0.15_0.004_200)]", vars: { "--plane-rotate": "6deg", "--plane-dx": "-12px", "--plane-dy": "12px", "--plane-duration": "52s" } },
  { className: "right-6 top-8 size-36 rounded-[36px] bg-[oklch(0.17_0.005_200)]", vars: { "--plane-rotate": "14deg", "--plane-dx": "-8px", "--plane-dy": "10px", "--plane-duration": "38s" } },
] as const;

export default function LoginDepthPlanes() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden lg:hidden">
      {PLANES.map((plane) => (
        <div key={plane.className} className={`absolute depth-plane ${plane.className}`} style={plane.vars as CSSProperties} />
      ))}
    </div>
  );
}
