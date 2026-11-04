import { noDifferences, type FlowVersionDiff } from "@/lib/flowVersionDiff";

/** One diff, in words: steps added / removed / edited, and the connections that moved (lib/flowVersionDiff). */
export default function FlowDiffList({ diff, same }: { diff: FlowVersionDiff; same: string }) {
  if (!diff.comparable) return <p className="mt-2 text-xs text-muted-foreground">One of these versions can&apos;t be read, so they can&apos;t be compared.</p>;
  if (noDifferences(diff)) return <p className="mt-2 text-xs text-muted-foreground">{same}</p>;
  const section = (title: string, items: string[], tone: string) =>
    items.length > 0 && (
      <div>
        <p className={`text-[10px] font-semibold uppercase tracking-wide ${tone}`}>{title} ({items.length})</p>
        <ul className="mt-1 space-y-0.5 text-xs">{items.slice(0, 40).map((item, i) => <li key={i}>{item}</li>)}{items.length > 40 && <li className="text-muted-foreground">…and {items.length - 40} more</li>}</ul>
      </div>
    );
  return (
    <div className="mt-2 grid gap-3 md:grid-cols-2">
      {diff.startChanged && <p className="text-xs md:col-span-2">Starts at “{diff.startChanged.to}” instead of “{diff.startChanged.from}”.</p>}
      {section("Steps added", diff.added, "text-emerald-300")}
      {section("Steps removed", diff.removed, "text-red-300")}
      {section("Steps edited", diff.changed.map((c) => `${c.label} — ${c.fields.join(", ")}`), "text-amber-300")}
      {section("Connections added", diff.connectionsAdded, "text-emerald-300")}
      {section("Connections removed", diff.connectionsRemoved, "text-red-300")}
    </div>
  );
}
