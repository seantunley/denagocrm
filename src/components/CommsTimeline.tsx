import { addCommunication, deleteCommunication } from "@/app/actions/communications";
import { formatDateTime } from "@/lib/format";

const typeIcons: Record<string, string> = {
  call: "📞",
  email: "✉️",
  whatsapp: "💬",
  meeting: "🤝",
  note: "📝",
};

type Comm = {
  id: string;
  type: string;
  direction: string | null;
  subject: string | null;
  body: string;
  occurredAt: Date;
  user: { name: string };
};

export default function CommsTimeline({
  communications,
  contactId,
  leadId,
  revalidate,
}: {
  communications: Comm[];
  contactId?: string;
  leadId?: string;
  revalidate: string;
}) {
  return (
    <div className="card">
      <h2 className="font-semibold mb-4">Communications</h2>

      <form action={addCommunication} className="mb-5 space-y-3 rounded-lg bg-slate-800/40 p-4 border border-slate-800">
        {contactId && <input type="hidden" name="contactId" value={contactId} />}
        {leadId && <input type="hidden" name="leadId" value={leadId} />}
        <input type="hidden" name="revalidate" value={revalidate} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="label">Type</label>
            <select name="type" className="input" defaultValue="call">
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="meeting">Meeting</option>
              <option value="note">Note</option>
            </select>
          </div>
          <div>
            <label className="label">Direction</label>
            <select name="direction" className="input" defaultValue="outbound">
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
              <option value="">—</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Subject</label>
            <input name="subject" className="input" placeholder="Optional subject" />
          </div>
        </div>
        <div>
          <label className="label">Details</label>
          <textarea
            name="body"
            className="input"
            rows={2}
            required
            placeholder="What was discussed?"
          />
        </div>
        <div className="flex items-end justify-between gap-3">
          <div>
            <label className="label">When</label>
            <input type="datetime-local" name="occurredAt" className="input" />
          </div>
          <button className="btn-primary">Log communication</button>
        </div>
      </form>

      {communications.length === 0 ? (
        <p className="text-sm text-slate-400">No communications logged yet.</p>
      ) : (
        <ol className="space-y-3">
          {communications.map((c) => (
            <li key={c.id} className="flex gap-3 group">
              <div className="text-lg leading-6 w-7 text-center shrink-0">
                {typeIcons[c.type] ?? "📝"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium capitalize">
                    {c.type}
                    {c.direction ? ` · ${c.direction}` : ""}
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatDateTime(c.occurredAt)} — {c.user.name}
                  </span>
                </div>
                {c.subject && (
                  <p className="text-sm font-medium text-slate-300">{c.subject}</p>
                )}
                <p className="text-sm text-slate-400 whitespace-pre-wrap">{c.body}</p>
              </div>
              <form action={deleteCommunication.bind(null, c.id, revalidate)}>
                <button
                  className="text-xs text-slate-600 hover:text-red-500 opacity-0 group-hover:opacity-100 cursor-pointer"
                  title="Delete"
                >
                  ✕
                </button>
              </form>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
