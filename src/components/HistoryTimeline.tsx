import { formatDateTime } from "@/lib/format";

const actionIcons: Record<string, string> = {
  contact: "👤",
  lead: "◎",
  vehicle: "⚡",
  jobcard: "🔧",
  service: "🛠",
  document: "📄",
  email: "✉️",
  activity: "✓",
  communication: "💬",
};

export default function HistoryTimeline({
  entries,
}: {
  entries: { id: string; action: string; summary: string; userName: string; createdAt: Date }[];
}) {
  if (entries.length === 0) {
    return <p className="text-sm text-slate-500">No history recorded yet.</p>;
  }
  return (
    <ol className="relative border-l border-slate-800 ml-2 space-y-5">
      {entries.map((e) => (
        <li key={e.id} className="ml-5">
          <span className="absolute -left-[11px] flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[10px]">
            {actionIcons[e.action.split(".")[0]] ?? "•"}
          </span>
          <p className="text-sm text-slate-200">{e.summary}</p>
          <p className="text-xs text-slate-500">
            by <span className="font-medium text-slate-400">{e.userName}</span> ·{" "}
            {formatDateTime(e.createdAt)}
          </p>
        </li>
      ))}
    </ol>
  );
}
