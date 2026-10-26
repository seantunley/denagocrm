/**
 * Halloween on the staff CRM (Sean, 2026-10-26: "put a Halloween theme on the
 * CRM, to be turned off on 1st November").
 *
 * Denago Cape Town's workspace only — another business on the platform keeps its
 * own look — and only the staff app: the customer portal, signing pages, PDFs and
 * emails are untouched. It ends by itself at midnight on 31 October,
 * Johannesburg time: the layout asks on every request, so nothing needs
 * switching off or deploying. Delete this file and its one use in
 * app/(app)/layout.tsx afterwards.
 */
export const HALLOWEEN_TENANT_ID = "tenant_denago_cpt";
export const HALLOWEEN_ENDS = new Date("2026-11-01T00:00:00+02:00");

export function halloweenOn(tenantId: string | null | undefined, now = new Date()): boolean {
  return tenantId === HALLOWEEN_TENANT_ID && now < HALLOWEEN_ENDS;
}

/** The app's colour tokens, retinted: purple-black surfaces, pumpkin accent, purple hover. Rendered after the brand style, so it wins. */
export const HALLOWEEN_CSS = `
:root {
  --background: oklch(0.155 0.03 300);
  --card: oklch(0.195 0.035 300);
  --popover: oklch(0.215 0.035 300);
  --secondary: oklch(0.24 0.04 300);
  --muted: oklch(0.24 0.04 300);
  --accent: oklch(0.29 0.07 300);
  --primary: oklch(0.72 0.19 52);
  --primary-foreground: oklch(0.16 0.03 300);
  --ring: oklch(0.72 0.19 52 / 60%);
  --border: oklch(0.8 0.1 300 / 13%);
  --sidebar: oklch(0.135 0.03 300);
  --sidebar-primary: oklch(0.72 0.19 52);
  --sidebar-primary-foreground: oklch(0.16 0.03 300);
  --sidebar-accent: oklch(0.25 0.06 300);
  --sidebar-border: oklch(0.8 0.1 300 / 10%);
  --sidebar-ring: oklch(0.72 0.19 52 / 60%);
  --chart-1: oklch(0.72 0.19 52);
}
body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  background: linear-gradient(90deg, oklch(0.72 0.19 52), oklch(0.6 0.2 300), oklch(0.72 0.19 52));
  box-shadow: 0 0 18px oklch(0.72 0.19 52 / 55%);
  pointer-events: none;
  z-index: 100;
}
@media print {
  body::before { display: none; }
}

/* Decorations (components/HalloweenDecor.tsx): above the header (z 40), under
   every dialog and the Ask bubble (z 50); never in the way of a click. */
.hw-decor { position: fixed; inset: 0; pointer-events: none; z-index: 45; overflow: hidden; }
.hw-decor * { pointer-events: none; }
.hw-web { position: absolute; top: 0; color: oklch(0.92 0.03 300 / 52%); filter: drop-shadow(0 0 2px oklch(0.92 0.03 300 / 35%)); }
.hw-web-left { left: 0; }
.hw-web-right { right: 0; transform: scaleX(-1); }
.hw-spider { position: absolute; top: 0; right: 118px; filter: drop-shadow(0 0 6px oklch(0.75 0.15 300 / 60%)); display: flex; flex-direction: column; align-items: center;
  animation: hw-bob 6s ease-in-out infinite; transform-origin: top center; }
.hw-thread { width: 1px; height: 90px; background: oklch(0.92 0.03 300 / 60%); }
.hw-pumpkins { position: absolute; bottom: 14px; left: 18px; display: flex; align-items: flex-end; gap: 4px; }
@media (min-width: 1024px) { .hw-pumpkins { left: calc(240px + 18px); } }
@media (max-width: 767px) { .hw-pumpkins { display: none; } .hw-web { width: 110px; height: 110px; } .hw-spider { right: 64px; } }
.hw-pumpkin { filter: drop-shadow(0 0 10px oklch(0.75 0.18 60 / 55%)); }
.hw-face { animation: hw-flicker 3.2s ease-in-out infinite; }
.hw-pumpkin-small .hw-face { animation-delay: 1.1s; }
.hw-pumpkin-mid .hw-face { animation-delay: 2.3s; }
.hw-ghost { position: absolute; left: -60px; opacity: 0; filter: drop-shadow(0 0 8px oklch(0.95 0 0 / 50%)); }
.hw-ghost-1 { top: 18%; animation: hw-drift 46s linear infinite 4s; }
.hw-ghost-2 { top: 34%; animation: hw-drift 58s linear infinite 27s; }
@keyframes hw-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(26px); } }
@keyframes hw-flicker { 0%, 100% { opacity: 1; } 42% { opacity: 0.75; } 47% { opacity: 1; } 71% { opacity: 0.85; } }
@keyframes hw-drift {
  0% { transform: translate(0, 0); opacity: 0; }
  4% { opacity: 0.5; }
  25% { transform: translate(28vw, -14px); }
  50% { transform: translate(55vw, 10px); }
  75% { transform: translate(82vw, -12px); }
  92% { opacity: 0.5; }
  100% { transform: translate(calc(100vw + 120px), 0); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .hw-spider, .hw-face { animation: none; }
  .hw-ghost { animation: none; opacity: 0.22; }
  .hw-ghost-1 { left: auto; right: 22%; }
  .hw-ghost-2 { display: none; }
}
@media print { .hw-decor { display: none; } }
`;
