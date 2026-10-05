import { createLucideIcon } from "lucide-react";

/**
 * The assistant's own mark: a ringed planet. Sparkles is the app's generic
 * "AI did this" icon (flows, forms, research); this one means DAX itself.
 * A lucide icon, so it sizes, colours and fits the nav like every other.
 */
export const DaxIcon = createLucideIcon("dax", [
  ["circle", { cx: "12", cy: "12", r: "5.1", fill: "currentColor", stroke: "none", key: "planet" }],
  ["path", { d: "M15.26 6.97A10.8 3.6 -25 0 1 17.94 12.73M8.74 17.03A10.8 3.6 -25 0 1 6.06 11.27", key: "ring" }],
]);
