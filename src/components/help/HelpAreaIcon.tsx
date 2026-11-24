import {
  Compass, SquareKanban, FileText, Package, Wrench, Megaphone, MessageSquare, Bot, FolderOpen,
  ChartColumnIncreasing, Cog, BookOpen, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HELP_AREA_STYLE } from "@/lib/help/areas";
import type { HelpCategoryKey } from "@/lib/help/types";

const ICONS: Record<string, LucideIcon> = {
  Compass, SquareKanban, FileText, Package, Wrench, Megaphone, MessageSquare, Bot, FolderOpen, ChartColumnIncreasing, Cog,
};

/** A help area's icon on a tile of the area's own colour (lib/help/areas.ts). Decorative: the area's name is beside it. */
export function HelpAreaTile({ area, icon, className }: { area: HelpCategoryKey; icon: string; className?: string }) {
  const Icon = ICONS[icon] ?? BookOpen;
  return (
    <span aria-hidden className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl depth-key", HELP_AREA_STYLE[area].tile, className)}>
      <Icon className="size-5" />
    </span>
  );
}

/** A small pill naming the area, in the area's colour. */
export function HelpAreaTag({ area, label }: { area: HelpCategoryKey; label: string }) {
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold", HELP_AREA_STYLE[area].tag)}>{label}</span>;
}
