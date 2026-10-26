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
`;
