import { scheduleActivity, completeActivity, cancelActivity, updateActivity } from "@/app/actions/activities";
import ModalTrigger from "@/components/Modal";
import ActivityTypeFields from "@/components/ActivityTypeFields";
import { formatDue } from "@/lib/format";

export const activityIcons: Record<string, string> = {
  call: "📞",
  email: "✉️",
  meeting: "🤝",
  whatsapp: "💬",
  test_drive: "🚗",
  follow_up: "🔁",
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
  /**
   * Which customer this activity belongs to. Only set where the panel shows an
   * AGGREGATE — the fleet page pools the activities of every contact in the
   * fleet, and "call about the battery" means nothing without knowing whose. On
   * a single contact's page the owner is the page you are already on, so it is
   * omitted and nothing renders.
   */
  contactLabel?: string | null;
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
  startOpen = false,
  hideCreate = false,
}: {
  activities: ActivityItem[];
  users: { id: string; name: string }[];
  currentUserId: string;
  leadId?: string;
  contactId?: string;
  revalidate: string;
  startOpen?: boolean;
  /**
   * Drop the "Schedule activity" form. For AGGREGATE views (the fleet page)
   * where there is no single record to attach a new activity to: with no
   * contactId or leadId the form would file an activity against nobody, which
   * reads as success and lands nowhere useful. Completing and editing the
   * activities already listed stays available — those carry their own ids.
   */
  hideCreate?: boolean;
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

      {!hideCreate && (
      <details className="mb-4 group" open={startOpen}>
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
        <ActivityTypeFields followUpNote />
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
          {/*
            An empty staff list used to render a <select> with NO options at
            all — a blank box with nothing in it and a defaultValue matching
            nothing. That was invisible while the list was every User row on the
            platform; now that it is the staff of one workspace it is reachable.
            A disabled select says what is going on, and submits no value, which
            is what the option-less one submitted too: scheduleActivity reads
            blank as "assign it to me".
          */}
          {users.length === 0 ? (
            <select className="input" disabled defaultValue="">
              <option value="">No assignable team members — this will be assigned to you</option>
            </select>
          ) : (
            <select name="assignedToId" className="input" defaultValue={currentUserId}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 pb-2 cursor-pointer">
          <input type="checkbox" name="workshop" className="h-4 w-4" />
          🔧 Workshop
        </label>
        <button className="btn-primary">Schedule</button>
        </form>
      </details>
      )}

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
                    {a.contactLabel && ` · ${a.contactLabel}`}
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
                    <ActivityTypeFields
                      defaultType={a.type}
                      defaultLocation={a.location ?? ""}
                      locationClass="col-span-2"
                    />
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
                    <div>
                      <label className="label">Assign to</label>
                      {/*
                        Same empty state as the create form above. The extra
                        care here is the SECOND way a scoped list bites on an
                        edit: the current assignee may no longer be in it — they
                        left the workspace, or were disabled — and a
                        `defaultValue` matching no option makes the browser
                        select the FIRST one, so an ordinary save would quietly
                        hand the task to whoever sorts first alphabetically. The
                        blank option gives that case somewhere honest to land.
                        It is not offered as a name, because listing a person
                        this workspace may not assign to is the disclosure we
                        just removed.
                      */}
                      {users.length === 0 ? (
                        <select className="input" disabled defaultValue="">
                          <option value="">No assignable team members — this will be assigned to you</option>
                        </select>
                      ) : (
                        <select
                          name="assignedToId"
                          className="input"
                          defaultValue={users.some((u) => u.id === a.assignedTo.id) ? a.assignedTo.id : ""}
                        >
                          <option value="">Assign to me</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                      )}
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
