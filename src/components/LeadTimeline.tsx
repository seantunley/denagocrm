import { Pin, PinOff } from "lucide-react";
import {
  addCommunication,
  toggleCommunicationPin,
} from "@/app/actions/communications";
import { toggleActivityPin } from "@/app/actions/timelinePins";
import { formatDateTime } from "@/lib/format";
import {
  getTimelinePins,
  type TimelinePinKind,
} from "@/lib/timelinePins";
import { compareTimelineItems } from "@/lib/timelineOrdering";
import PasteImageInput from "@/components/PasteImageInput";

/* eslint-disable @next/next/no-img-element */
const logo = (src: string, alt: string) => (
  <img
    src={src}
    alt={alt}
    className="h-3.5 w-3.5 rounded-[3px] object-contain"
  />
);
/* eslint-enable @next/next/no-img-element */

const icons: Record<string, React.ReactNode> = {
  note: "📝",
  call: "📞",
  email: "✉️",
  whatsapp: logo("/branding/social-whatsapp.png", "WhatsApp"),
  messenger: logo("/branding/social-facebook.png", "Messenger"),
  instagram: logo("/branding/social-instagram.png", "Instagram"),
  meeting: "🤝",
  audit: "•",
  lead: "◎",
  contact: "👤",
  automation: "🤖",
  activity: "✓",
  todo: "✓",
  test_drive: "🚗",
  document: "📄",
  creation: "🟢",
};

type PinTarget = {
  kind: TimelinePinKind;
  itemId: string;
};

type Item = {
  id: string;
  icon: React.ReactNode;
  title: string;
  body?: string | null;
  image?: string | null;
  who: string;
  when: Date;
  /** Not-yet-completed activity — floats above normal history. */
  pending?: boolean;
  activityStatus?: string;
  /** Explicit user pin — remains above every other timeline entry until unpinned. */
  pinnedAt?: Date | null;
  pinTarget?: PinTarget;
};

export default async function LeadTimeline({
  leadId,
  contactId,
  revalidate,
  audit,
  communications,
  activities = [],
  creationNote,
}: {
  leadId?: string;
  contactId?: string;
  revalidate: string;
  audit: {
    id: string;
    action: string;
    summary: string;
    userName: string;
    createdAt: Date;
  }[];
  communications: {
    id: string;
    type: string;
    direction: string | null;
    subject: string | null;
    body: string;
    attachmentUrl?: string | null;
    occurredAt: Date;
    user: { name: string };
  }[];
  activities?: {
    id: string;
    type: string;
    summary: string;
    location?: string | null;
    dueDate: Date;
    status: string;
    assignedTo?: { name: string } | null;
  }[];
  creationNote: { text: string; when: Date; who: string } | null;
}) {
  const pins = await getTimelinePins([
    ...activities.map((activity) => ({
      kind: "activity" as const,
      itemId: activity.id,
    })),
    ...communications.map((communication) => ({
      kind: "communication" as const,
      itemId: communication.id,
    })),
  ]);
  const pinByTarget = new Map(
    pins.map((pin) => [`${pin.kind}:${pin.itemId}`, pin.pinnedAt]),
  );
  const pinnedAt = (kind: TimelinePinKind, itemId: string) =>
    pinByTarget.get(`${kind}:${itemId}`) ?? null;

  const items: Item[] = [
    ...activities
      .filter(
        (activity) =>
          activity.status === "planned" ||
          Boolean(pinnedAt("activity", activity.id)),
      )
      .map((activity): Item => ({
        id: `act-${activity.id}`,
        icon: icons[activity.type] ?? icons.activity,
        title: activity.summary,
        body: activity.location ? `📍 ${activity.location}` : null,
        who: activity.assignedTo?.name ?? "Unassigned",
        when: activity.dueDate,
        pending: activity.status === "planned",
        activityStatus: activity.status,
        pinnedAt: pinnedAt("activity", activity.id),
        pinTarget: { kind: "activity", itemId: activity.id },
      })),
    ...audit.map((entry): Item => ({
      id: `a-${entry.id}`,
      icon: icons[entry.action.split(".")[0]] ?? "•",
      title: entry.summary,
      who: entry.userName,
      when: entry.createdAt,
    })),
    ...communications.map((communication): Item => ({
      id: `c-${communication.id}`,
      icon: icons[communication.type] ?? "💬",
      title: `${communication.type.charAt(0).toUpperCase() + communication.type.slice(1)}${
        communication.direction ? ` (${communication.direction})` : ""
      }${communication.subject ? `: ${communication.subject}` : ""}`,
      body: communication.body,
      image: communication.attachmentUrl ?? null,
      who: communication.user.name,
      when: communication.occurredAt,
      pinnedAt: pinnedAt("communication", communication.id),
      pinTarget: { kind: "communication", itemId: communication.id },
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
          } satisfies Item,
        ]
      : []),
  ].sort(compareTimelineItems);

  return (
    <div className="card min-w-0">
      <div className="mb-4">
        <h2 className="font-semibold">Live timeline</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Pin an important note or action to keep it at the top until it is unpinned.
        </p>
      </div>

      <form action={addCommunication} className="mb-5 space-y-2">
        {leadId && <input type="hidden" name="leadId" value={leadId} />}
        {contactId && (
          <input type="hidden" name="contactId" value={contactId} />
        )}
        <input type="hidden" name="type" value="note" />
        <input type="hidden" name="direction" value="" />
        <input type="hidden" name="revalidate" value={revalidate} />
        <textarea
          name="body"
          className="input"
          rows={2}
          placeholder="Add an internal note…"
        />
        <PasteImageInput />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            name="pin"
            className="size-3.5 rounded border-slate-700 bg-slate-900 accent-orange-500"
          />
          Pin this note to the top
        </label>
        <button className="btn-secondary btn-sm w-full">+ Add note</button>
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing recorded yet.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 [scrollbar-width:thin]">
          <ol className="relative ml-3 space-y-3 border-l border-slate-800 py-0.5">
            {items.map((item) => {
              const isPinned = Boolean(item.pinnedAt);
              const pinAction =
                item.pinTarget?.kind === "activity"
                  ? toggleActivityPin.bind(
                      null,
                      item.pinTarget.itemId,
                      revalidate,
                    )
                  : item.pinTarget?.kind === "communication"
                    ? toggleCommunicationPin.bind(
                        null,
                        item.pinTarget.itemId,
                        revalidate,
                      )
                    : null;

              return (
                <li
                  key={item.id}
                  className={`ml-5 rounded-lg px-2 py-2 ${
                    isPinned
                      ? "border border-orange-500/30 bg-orange-500/[0.07]"
                      : "border border-transparent"
                  }`}
                >
                  <span
                    className={`absolute -left-[11px] flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                      isPinned
                        ? "bg-orange-500/25 ring-1 ring-orange-400/60"
                        : item.pending
                          ? "bg-amber-500/20 ring-1 ring-amber-500/40"
                          : "bg-slate-800"
                    }`}
                  >
                    {item.icon}
                  </span>
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 break-words text-sm text-slate-200 [overflow-wrap:anywhere]">
                      {isPinned && (
                        <span className="mr-2 inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-orange-300">
                          <Pin className="size-2.5" />
                          Pinned
                        </span>
                      )}
                      {item.pending && (
                        <span className="mr-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                          {item.when < new Date() ? "Overdue" : "Upcoming"}
                        </span>
                      )}
                      {item.activityStatus &&
                        item.activityStatus !== "planned" && (
                          <span className="mr-2 rounded-full bg-slate-700/70 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-slate-300">
                            {item.activityStatus === "done"
                              ? "Completed"
                              : "Canceled"}
                          </span>
                        )}
                      {item.title}
                    </p>
                    {item.pinTarget && pinAction && (
                      <form action={pinAction} className="shrink-0">
                        <button
                          type="submit"
                          title={
                            isPinned
                              ? "Unpin from the top"
                              : "Pin to the top"
                          }
                          aria-label={
                            isPinned
                              ? "Unpin timeline entry"
                              : "Pin timeline entry"
                          }
                          className={`inline-flex size-7 items-center justify-center rounded-md transition-colors ${
                            isPinned
                              ? "bg-orange-500/15 text-orange-300 hover:bg-orange-500/25"
                              : "text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                          }`}
                        >
                          {isPinned ? (
                            <PinOff className="size-3.5" />
                          ) : (
                            <Pin className="size-3.5" />
                          )}
                        </button>
                      </form>
                    )}
                  </div>
                  {item.image && (
                    <a href={item.image} target="_blank">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.image}
                        alt="Attachment"
                        className="mt-1 max-h-36 rounded-lg border border-slate-700 transition-colors hover:border-orange-500"
                      />
                    </a>
                  )}
                  {item.body && item.body !== "🖼 Image" && (
                    <p className="mt-0.5 line-clamp-4 break-words whitespace-pre-wrap text-xs text-slate-400 [overflow-wrap:anywhere]">
                      {item.body}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="font-medium text-slate-400">
                      {item.who}
                    </span>{" "}
                    · {formatDateTime(item.when)}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
