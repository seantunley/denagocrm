import { scheduleActivity, completeActivity, cancelActivity, updateActivity } from "@/app/actions/activities";
import ModalTrigger from "@/components/Modal";
import { formatDate, formatDue } from "@/lib/format";

export const activityIcons: Record<string, string> = {
  call: "📞",
  email: "✉️",
  meeting: "🤝",
  whatsapp: "💬",
  test_drive: "🚗",
  todo: "☑️",
};

type ActivityItem = {
  id: string;
  type: string;
  category?: string | null;
  summary: string;
  note: string | null;
  location: string | null;
  dueDate: Date;
  status: string;
  assignedTo: { id: string; name: string };
};

/** UTC-stored due date → datetime-local value in SA time (date-only stays 00:00). */
function toLocalInput(d: Date): string {
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) {
    return d.toISOString().slice(0, 10) + "T00:00";
  }
  return new Date(d.getTime() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

export default function ActivityPanel({
  activities,
  users,
  currentUserId,
  leadId,
  contactId,
  revalidate,
}: {
  activities: ActivityItem[];
  users: { id: string; name: string }[];
  currentUserId: string;
  leadId?: string;
  contactId?: string;
  revalidate: string;
}) {
  const planned = activities
    .filter((a) => a.status === "planned")
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  const recent = activities.filter((a) => a.status === "done").slice(0, 3);
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">Planned activities</h2>
      </div>

      <details className="mb-4 group">
        <summary className="btn-secondary btn-sm inline-flex cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          + Schedule activity
        </summary>
        <form
          action={scheduleActivity}
          className="mt-3 rounded-lg bg-slate-800/40 p-4 border border-slate-800 grid grid-cols-2 md:grid-cols-4 gap-3 items-end"
        >
        {leadId && <input type="hidden" name="leadId" value={leadId} />}
        {contactId && <input type="hidden" name="contactId" value={contactId} />}
        <input type="hidden" name="revalidate" value={revalidate} />
        <div>
          <label className="label">Type</label>
          <select name="type" className="input" defaultValue="call">
            <option value="call">Call</option>
            <option value="email">Email</option>
            <option value="meeting">Meeting</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="test_drive">🚗 Test drive</option>
            <option value="todo">To-do</option>
          </select>
        </div>
        <div className="col-span-1 md:col-span-2">
          <label className="label">What needs doing?</label>
          <input name="summary" className="input" required placeholder="e.g. Follow up on quote" />
        </div>
        <div>
          <label className="label">Due</label>
          <input type="datetime-local" name="dueDate" className="input" required />
        </div>
        <div className="col-span-2 md:col-span-2">
          <label className="label">Assign to</label>
          <select name="assignedToId" className="input" defaultValue={currentUserId}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-2 md:col-span-3">
          <label className="label">📍 Location (optional — meetings & test drives)</label>
          <input
            name="location"
            className="input"
            placeholder="Address, estate or Google Maps link"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 pb-2 cursor-pointer">
          <input type="checkbox" name="workshop" className="h-4 w-4" />
          🔧 Workshop
        </label>
        <button className="btn-primary">Schedule</button>
        </form>
      </details>

      {planned.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing planned. Schedule the next step so this doesn&apos;t go cold.
        </p>
      ) : (
        <ul className="space-y-3">
          {planned.map((a) => {
            const overdue = a.dueDate < new Date(new Date().toDateString());
            const dueToday = !overdue && a.dueDate <= today;
            return (
              <li key={a.id} className="flex items-start gap-3">
                <span className="text-lg leading-6 w-7 text-center shrink-0">
                  {activityIcons[a.type] ?? "☑️"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{a.summary}</p>
                  <p className="text-xs text-slate-400">
                    <span
                      className={
                        overdue
                          ? "text-red-400 font-semibold"
                          : dueToday
                          ? "text-amber-300 font-semibold"
                          : ""
                      }
                    >
                      {overdue ? "Overdue — " : dueToday ? "Today — " : ""}
                      {formatDue(a.dueDate)}
                    </span>{" "}
                    · {a.assignedTo.name}
                    {a.location && (
                      <>
                        {" · "}
                        <a
                          href={
                            a.location.startsWith("http")
                              ? a.location
                              : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.location)}`
                          }
                          target="_blank"
                          className="text-sky-400 hover:underline"
                        >
                          📍 Map
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <form
                  action={completeActivity.bind(null, a.id)}
                  className="flex items-center gap-1.5"
                >
                  <input type="hidden" name="revalidate" value={revalidate} />
                  <input
                    name="note"
                    className="input btn-sm w-36 hidden md:block"
                    placeholder="Outcome note…"
                  />
                  <button className="btn-secondary btn-sm" title="Mark done">
                    ✓ Done
                  </button>
                </form>
                <ModalTrigger
                  label="✎"
                  title="Edit activity"
                  buttonClass="text-xs text-slate-600 hover:text-orange-400 cursor-pointer mt-1.5"
                >
                  <form
                    action={updateActivity.bind(null, a.id)}
                    className="card grid grid-cols-2 gap-3 items-end"
                  >
                    <input type="hidden" name="revalidate" value={revalidate} />
                    <div>
                      <label className="label">Type</label>
                      <select name="type" className="input" defaultValue={a.type}>
                        <option value="call">Call</option>
                        <option value="email">Email</option>
                        <option value="meeting">Meeting</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="test_drive">🚗 Test drive</option>
                        <option value="todo">To-do</option>
                      </select>
                    </div>
                    <div>
                      <label className="label">Due</label>
                      <input
                        type="datetime-local"
                        name="dueDate"
                        className="input"
                        defaultValue={toLocalInput(a.dueDate)}
                        required
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="label">What needs doing?</label>
                      <input name="summary" className="input" required defaultValue={a.summary} />
                    </div>
                    <div className="col-span-2">
                      <label className="label">📍 Location (optional)</label>
                      <input
                        name="location"
                        className="input"
                        defaultValue={a.location ?? ""}
                        placeholder="Address, estate or Google Maps link"
                      />
                    </div>
                    <div>
                      <label className="label">Assign to</label>
                      <select name="assignedToId" className="input" defaultValue={a.assignedTo.id}>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-300 pb-2 cursor-pointer">
                      <input
                        type="checkbox"
                        name="workshop"
                        className="h-4 w-4"
                        defaultChecked={a.category === "workshop"}
                      />
                      🔧 Workshop
                    </label>
                    <div className="col-span-2">
                      <button className="btn-primary w-full">Save changes</button>
                    </div>
                  </form>
                </ModalTrigger>
                <form action={cancelActivity.bind(null, a.id, revalidate)}>
                  <button
                    className="text-xs text-slate-600 hover:text-red-500 cursor-pointer mt-1.5"
                    title="Cancel"
                  >
                    ✕
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}

      {recent.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-800">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
            Recently completed
          </p>
          <ul className="space-y-1">
            {recent.map((a) => (
              <li key={a.id} className="text-xs text-slate-500 line-through">
                {activityIcons[a.type]} {a.summary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
