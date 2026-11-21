import { SaveForm, SaveButton } from "@/components/SaveForm";
import { addSignatureNotice, removeSignatureNotice } from "@/app/actions/signatureNotices";
import { NOTICE_MAX, type NoticeState } from "@/lib/signatureNotices";

export type NoticeItem = { id: string; text: string; startsOn: string; endsOn: string; state: NoticeState; who?: string };

const STATE_LABEL: Record<NoticeState, string> = { live: "Showing now", scheduled: "Starts later", ended: "Ended" };

/** "5 Jan 2027" from "2027-01-05" (a South African day, as stored). */
const day = (value: string) => new Date(`${value}T12:00:00+02:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Johannesburg" });

/**
 * Dated signature lines (lib/signatureNotices.ts): the ones on now and to come, and a form to add one. Used twice on
 * the Email signatures page — your own (your leave), and the owner's for everyone (holiday hours).
 */
export default function SignatureNotices({
  items,
  forEveryone,
  today,
  placeholder,
}: {
  items: NoticeItem[];
  forEveryone: boolean;
  /** Today, as the date inputs take it — the first day defaults to it. */
  today: string;
  placeholder: string;
}) {
  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-words font-medium">{item.text}</span>
              <span className="text-xs text-muted-foreground">
                {item.who ? `${item.who} · ` : ""}
                {day(item.startsOn)} – {day(item.endsOn)} · {STATE_LABEL[item.state]}
              </span>
              <SaveForm action={removeSignatureNotice} success="Removed" resetOnSuccess={false}>
                <input type="hidden" name="id" value={item.id} />
                <SaveButton className="btn-secondary btn-sm" pendingLabel="Removing…">Remove</SaveButton>
              </SaveForm>
            </li>
          ))}
        </ul>
      )}
      <SaveForm action={addSignatureNotice} success="Saved — it shows on the days you chose" className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        {forEveryone && <input type="hidden" name="for" value="everyone" />}
        <label className="block space-y-1">
          <span className="label">Line</span>
          <input name="text" required maxLength={NOTICE_MAX} placeholder={placeholder} className="input" />
        </label>
        <label className="block space-y-1">
          <span className="label">First day</span>
          <input type="date" name="startsOn" required defaultValue={today} min={today} className="input" />
        </label>
        <label className="block space-y-1">
          <span className="label">Last day</span>
          <input type="date" name="endsOn" required min={today} className="input" />
        </label>
        <SaveButton className="btn-primary btn-sm" pendingLabel="Adding…">Add line</SaveButton>
      </SaveForm>
    </div>
  );
}
