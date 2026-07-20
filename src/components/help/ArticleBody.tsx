import { Fragment, type ReactNode } from "react";
import { Lightbulb, TriangleAlert, Info } from "lucide-react";
import type { HelpBlock } from "@/lib/help/types";
import { cn } from "@/lib/utils";

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

type Variant = "app" | "print";

/** Render a text string honouring inline **bold** markers and HTML entities. */
function inline(text: string, strongCls: string): ReactNode {
  const decoded = decodeEntities(text);
  const parts = decoded.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className={cn("font-semibold", strongCls)}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const THEME = {
  app: {
    h: "text-foreground", p: "text-muted-foreground", strong: "text-foreground",
    stepBadge: "bg-primary/15 text-primary", bullet: "bg-muted-foreground/50",
    tableWrap: "border-border", tableHead: "border-border bg-white/[0.02] text-muted-foreground",
    tableRow: "border-border/60", cell: "text-muted-foreground",
    callout: {
      tip: "border-emerald-500/30 bg-emerald-500/[0.07] text-emerald-100/90",
      warning: "border-amber-500/30 bg-amber-500/[0.07] text-amber-100/90",
      info: "border-sky-500/30 bg-sky-500/[0.07] text-sky-100/90",
    },
  },
  print: {
    h: "text-slate-900", p: "text-slate-700", strong: "text-slate-900",
    stepBadge: "bg-orange-100 text-orange-700", bullet: "bg-slate-400",
    tableWrap: "border-slate-200", tableHead: "border-slate-200 bg-slate-50 text-slate-500",
    tableRow: "border-slate-100", cell: "text-slate-700",
    callout: {
      tip: "border-emerald-200 bg-emerald-50 text-emerald-900",
      warning: "border-amber-200 bg-amber-50 text-amber-900",
      info: "border-sky-200 bg-sky-50 text-sky-900",
    },
  },
} as const;

const ICON = { tip: Lightbulb, warning: TriangleAlert, info: Info } as const;
const CALLOUT_ICON_CLS = { tip: "text-emerald-500", warning: "text-amber-500", info: "text-sky-500" } as const;

export default function ArticleBody({ body, variant = "app" }: { body: HelpBlock[]; variant?: Variant }) {
  const t = THEME[variant];
  return (
    <div className="space-y-4">
      {body.map((block, i) => {
        switch (block.type) {
          case "h":
            return <h3 key={i} className={cn("pt-2 text-base font-semibold", t.h)}>{inline(block.text, t.strong)}</h3>;
          case "p":
            return <p key={i} className={cn("text-[15px] leading-relaxed", t.p)}>{inline(block.text, t.strong)}</p>;
          case "steps":
            return (
              <ol key={i} className="space-y-2">
                {block.items.map((item, j) => (
                  <li key={j} className={cn("flex gap-3 text-[15px] leading-relaxed", t.p)}>
                    <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", t.stepBadge)}>{j + 1}</span>
                    <span>{inline(item, t.strong)}</span>
                  </li>
                ))}
              </ol>
            );
          case "list":
            return (
              <ul key={i} className="space-y-1.5">
                {block.items.map((item, j) => (
                  <li key={j} className={cn("flex gap-2.5 text-[15px] leading-relaxed", t.p)}>
                    <span className={cn("mt-2 size-1.5 shrink-0 rounded-full", t.bullet)} />
                    <span>{inline(item, t.strong)}</span>
                  </li>
                ))}
              </ul>
            );
          case "callout": {
            const Icon = ICON[block.tone];
            return (
              <div key={i} className={cn("flex gap-3 rounded-xl border p-3.5 text-[14px] leading-relaxed", t.callout[block.tone])}>
                <Icon className={cn("mt-0.5 size-4 shrink-0", CALLOUT_ICON_CLS[block.tone])} />
                <p>{inline(block.text, "font-semibold")}</p>
              </div>
            );
          }
          case "table":
            return (
              <div key={i} className={cn("overflow-x-auto rounded-xl border", t.tableWrap)}>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className={cn("border-b", t.tableHead)}>
                      {block.headers.map((h, j) => (
                        <th key={j} className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide">{inline(h, t.strong)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className={cn("border-b last:border-0", t.tableRow)}>
                        {row.map((cell, c2) => (
                          <td key={c2} className={cn("px-3 py-2 align-top", t.cell)}>{inline(cell, t.strong)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
