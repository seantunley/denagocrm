import type { HelpCategoryKey } from "./types";

/**
 * Each help area's own colour (2026-11-23; the canvas board "Help centre — home").
 * Eleven areas wearing the same orange icon read as one grey wall; a colour per
 * area makes Sales, Workshop and Marketing recognisable before they are read.
 *
 * Decoration only — every tile also carries its icon and its name, so nothing
 * depends on telling two colours apart. The class names are written out in
 * full because Tailwind finds classes by scanning source, not by running it.
 */
export type HelpAreaStyle = {
  /** The icon tile: a tinted square with the icon in the area's colour. */
  tile: string;
  /** A small pill naming the area. */
  tag: string;
  /** A top edge for a card that belongs to the area. */
  edge: string;
};

export const HELP_AREA_STYLE: Record<HelpCategoryKey, HelpAreaStyle> = {
  "getting-started": { tile: "bg-amber-400/15 text-amber-300", tag: "bg-amber-400/15 text-amber-200", edge: "border-t-amber-400/70" },
  crm: { tile: "bg-blue-400/15 text-blue-300", tag: "bg-blue-400/15 text-blue-200", edge: "border-t-blue-400/70" },
  sales: { tile: "bg-emerald-400/15 text-emerald-300", tag: "bg-emerald-400/15 text-emerald-200", edge: "border-t-emerald-400/70" },
  stock: { tile: "bg-lime-400/15 text-lime-300", tag: "bg-lime-400/15 text-lime-200", edge: "border-t-lime-400/70" },
  workshop: { tile: "bg-orange-400/15 text-orange-300", tag: "bg-orange-400/15 text-orange-200", edge: "border-t-orange-400/70" },
  marketing: { tile: "bg-pink-400/15 text-pink-300", tag: "bg-pink-400/15 text-pink-200", edge: "border-t-pink-400/70" },
  comms: { tile: "bg-sky-400/15 text-sky-300", tag: "bg-sky-400/15 text-sky-200", edge: "border-t-sky-400/70" },
  automation: { tile: "bg-violet-400/15 text-violet-300", tag: "bg-violet-400/15 text-violet-200", edge: "border-t-violet-400/70" },
  documents: { tile: "bg-teal-400/15 text-teal-300", tag: "bg-teal-400/15 text-teal-200", edge: "border-t-teal-400/70" },
  governance: { tile: "bg-cyan-400/15 text-cyan-300", tag: "bg-cyan-400/15 text-cyan-200", edge: "border-t-cyan-400/70" },
  admin: { tile: "bg-slate-400/15 text-slate-300", tag: "bg-slate-400/15 text-slate-200", edge: "border-t-slate-400/70" },
};
