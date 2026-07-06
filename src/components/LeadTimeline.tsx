import { addCommunication } from "@/app/actions/communications";
import { formatDateTime } from "@/lib/format";

const icons: Record<string, string> = {
  note: "📝",
  call: "📞",
  email: "✉️",
  whatsapp: "💬",
  meeting: "🤝",
  audit: "•",
  lead: "◎",
  contact: "👤",
  automation: "🤖",
  activity: "✓",
  document: "📄",
  creation: "🟢",
};

type Item = {
  id: string;
  icon: string;
  title: string;
  body?: string | null;
  who: string;
  when: Date;
};

export default function LeadTimeline({
  leadId,
  contactId,
  revalidate,
  audit,
  communications,
  creationNote,
}: {
  leadId?: string;
  contactId?: string;
  revalidate: string;
  audit: { id: string; action: string; summary: string; userName: string; createdAt: Date }[];
  communications: {
    id: string;
    type: string;
    direction: string | null;
    subject: string | null;
    body: string;
    occurredAt: Date;
    user: { name: string };
  }[];
  creationNote: { text: string; when: Date; who: string } | null;
}) {
  const items: Item[] = [
    ...audit.map((a) => ({
      id: `a-${a.id}`,
      icon: icons[a.action.split(".")[0]] ?? "•",
      title: a.summary,
      who: a.userName,
      when: a.createdAt,
    })),
    ...communications.map((c) => ({
      id: `c-${c.id}`,
      icon: icons[c.type] ?? "💬",
      title: `${c.type.charAt(0).toUpperCase() + c.type.slice(1)}${
        c.direction ? ` (${c.direction})` : ""
      }${c.subject ? `: ${c.subject}` : ""}`,
      body: c.body,
      who: c.user.name,
      when: c.occurredAt,
    })),
    ...(creationNote
      ? [
          {
            id: "creation-note",
            icon: icons.creation,
            title: "Note at creation",
            body: creationNote.text,
            who: creationNote.who,
            when: creationNote.when,
          },
        ]
      : []),
  ].sort((a, b) => b.when.getTime() - a.when.getTime());

  return (
    <div className="card">
      <h2 className="font-semibold mb-4">Live timeline</h2>

      <form action={addCommunication} className="mb-5 space-y-2">
        {leadId && <input type="hidden" name="leadId" value={leadId} />}
        {contactId && <input type="hidden" name="contactId" value={contactId} />}
        <input type="hidden" name="type" value="note" />
        <input type="hidden" name="direction" value="" />
        <input type="hidden" name="revalidate" value={revalidate} />
        <textarea
          name="body"
          className="input"
          rows={2}
          required
          placeholder="Add an internal note…"
        />
        <button className="btn-secondary btn-sm w-full">+ Add note</button>
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing recorded yet.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-width:thin]">
          <ol className="relative border-l border-slate-800 ml-3 space-y-5 py-0.5">
          {items.map((item) => (
            <li key={item.id} className="ml-5">
              <span className="absolute -left-[11px] flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-[10px]">
                {item.icon}
              </span>
              <p className="text-sm text-slate-200">{item.title}</p>
              {item.body && (
                <p className="text-xs text-slate-400 whitespace-pre-wrap mt-0.5 line-clamp-4">
                  {item.body}
                </p>
              )}
              <p className="text-xs text-slate-500 mt-0.5">
                <span className="font-medium text-slate-400">{item.who}</span> ·{" "}
                {formatDateTime(item.when)}
              </p>
            </li>
          ))}
          </ol>
        </div>
      )}
    </div>
  );
}
