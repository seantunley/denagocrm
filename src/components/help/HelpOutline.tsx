import type { OutlineItem } from "@/lib/help/outline";

/** "On this page": the guide's headings as links, beside the guide on a wide screen (lib/help/outline.ts). */
export default function HelpOutline({ items }: { items: OutlineItem[] }) {
  return (
    <nav aria-label="On this page">
      <p className="pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">On this page</p>
      <ul className="border-l border-white/10">
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`} className="-ml-px flex min-h-9 items-center border-l-2 border-transparent py-1.5 pl-3 text-[13px] leading-snug text-muted-foreground transition-colors hover:border-primary hover:text-foreground">
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
