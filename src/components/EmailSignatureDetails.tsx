import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { saveMySignatureDetails, saveSignatureRules, saveStaffSignatureDetails } from "@/app/actions/emailSignatures";
import { SIGNATURE_FIELDS, SIGNATURE_FIELD_LABELS, mayEdit, type SignatureField, type TeamLine } from "@/lib/signaturePeople";

export type PersonDetails = {
  qualifications: string | null;
  directLine: string | null;
  whatsapp: string | null;
  bookingUrl: string | null;
  hours: string | null;
  photo: boolean;
  /** A profile photo exists to show (it is uploaded in Settings → My account). */
  hasPhoto: boolean;
};

const PLACEHOLDER: Record<Exclude<SignatureField, "photo">, string> = {
  qualifications: "e.g. BCom (Hons), CA(SA)",
  directLine: "e.g. 021 555 1234",
  whatsapp: "e.g. 082 555 1234",
  bookingUrl: "https://… (your calendar booking page)",
  hours: "e.g. Mon–Fri 8:00–17:00",
};

/**
 * The details half of one person's signature form. Fields this viewer may not change are shown, not editable — and are
 * not sent, so the server leaves them exactly as they are (app/actions/emailSignatures.ts checks again).
 */
function DetailFields({ person, locked, isOwner }: { person: PersonDetails; locked: readonly SignatureField[]; isOwner: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {SIGNATURE_FIELDS.filter((field): field is Exclude<SignatureField, "photo"> => field !== "photo").map((field) =>
        mayEdit(field, locked, isOwner) ? (
          <label key={field} className="block space-y-1">
            <span className="label">{SIGNATURE_FIELD_LABELS[field]}</span>
            <input name={field} defaultValue={person[field] ?? ""} placeholder={PLACEHOLDER[field]} className="input" maxLength={field === "bookingUrl" ? 300 : 120} />
          </label>
        ) : (
          <div key={field} className="space-y-1">
            <span className="label">{SIGNATURE_FIELD_LABELS[field]}</span>
            <p className="text-sm text-muted-foreground">{person[field] || "—"} <span className="text-xs">(set by the workspace owner)</span></p>
          </div>
        ),
      )}
      {mayEdit("photo", locked, isOwner) ? (
        <label className="flex items-start gap-2 text-sm sm:col-span-2">
          <input type="hidden" name="photoShown" value="1" />
          <input type="checkbox" name="photo" defaultChecked={person.photo} className="mt-1 accent-primary" disabled={!person.hasPhoto && !person.photo} />
          <span>
            Show the profile photo on the signature
            {!person.hasPhoto && (
              <span className="block text-xs text-muted-foreground">
                No profile photo yet — add one in <Link href="/settings?tab=account" className="underline">Settings → My account</Link> first.
              </span>
            )}
          </span>
        </label>
      ) : (
        <p className="text-sm text-muted-foreground sm:col-span-2">Photo on the signature: {person.photo ? "on" : "off"} <span className="text-xs">(set by the workspace owner)</span></p>
      )}
    </div>
  );
}

/**
 * The Email signatures pack's people settings (items 1–4): your own details; for the owner, the rules (locked details,
 * a line per team, short replies) and every team member's details.
 */
export default function EmailSignatureDetails({
  me,
  locked,
  isOwner,
  teams,
  teamLines,
  shortReplies,
  staff,
}: {
  me: PersonDetails;
  locked: readonly SignatureField[];
  isOwner: boolean;
  teams: { id: string; name: string }[];
  teamLines: readonly TeamLine[];
  shortReplies: boolean;
  staff: (PersonDetails & { id: string; name: string; email: string })[];
}) {
  const lineFor = (teamId: string) => teamLines.find((row) => row.teamId === teamId)?.line ?? "";
  return (
    <div className="space-y-6">
      <section className="card max-w-3xl space-y-3 p-5">
        <h2 className="text-base font-semibold">Your details</h2>
        <p className="text-xs text-muted-foreground">
          Each shows on your signature only when it is filled in. Your name, job title and mobile come from Settings → My account.
        </p>
        <SaveForm action={saveMySignatureDetails} resetOnSuccess={false} success="Saved" className="space-y-3">
          <DetailFields person={me} locked={locked} isOwner={isOwner} />
          <SaveButton className="btn-primary btn-sm">Save my details</SaveButton>
        </SaveForm>
      </section>

      {isOwner && (
        <section className="card max-w-3xl space-y-3 p-5">
          <h2 className="text-base font-semibold">Rules for everyone</h2>
          <SaveForm action={saveSignatureRules} resetOnSuccess={false} success="Saved" className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Details staff can&apos;t change</legend>
              <p className="text-xs text-muted-foreground">Ticked details are set by you below, for each person. Unticked, people set their own.</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {SIGNATURE_FIELDS.map((field) => (
                  <label key={field} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name={`lock_${field}`} defaultChecked={locked.includes(field)} className="accent-primary" />
                    {SIGNATURE_FIELD_LABELS[field]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="shortReplies" defaultChecked={shortReplies} className="mt-1 accent-primary" />
              <span>
                Short signature on replies
                <span className="block text-xs text-muted-foreground">
                  The full signature on a new email; two plain lines (name, title, phone, email) when replying, so long threads don&apos;t repeat it.
                </span>
              </span>
            </label>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">A line for each team</legend>
              {teams.length === 0 ? (
                <p className="text-xs text-muted-foreground">No teams yet — add them in Settings → Team &amp; access.</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Shown under the signature of everyone in that team. Someone in two teams gets the first that is theirs.</p>
                  {teams.map((team) => (
                    <label key={team.id} className="block space-y-1">
                      <span className="text-sm">{team.name}</span>
                      <input name={`team_${team.id}`} defaultValue={lineFor(team.id)} maxLength={160} placeholder="e.g. Workshop: Mon–Fri 8:00–17:00 · Parts 021 555 1234" className="input" />
                    </label>
                  ))}
                </>
              )}
            </fieldset>
            <SaveButton className="btn-primary btn-sm">Save rules</SaveButton>
          </SaveForm>
        </section>
      )}

      {isOwner && staff.length > 0 && (
        <section className="card max-w-3xl space-y-3 p-5">
          <h2 className="text-base font-semibold">Your team&apos;s details</h2>
          <p className="text-xs text-muted-foreground">Set any detail for anyone — including the ones staff can&apos;t change themselves.</p>
          <ul className="divide-y divide-border/60">
            {staff.map((person) => (
              <li key={person.id} className="py-2">
                <details>
                  <summary className="cursor-pointer text-sm">
                    {person.name} <span className="text-muted-foreground">· {person.email}</span>
                  </summary>
                  <SaveForm action={saveStaffSignatureDetails.bind(null, person.id)} resetOnSuccess={false} success="Saved" className="mt-3 space-y-3">
                    <DetailFields person={person} locked={[]} isOwner />
                    <SaveButton className="btn-secondary btn-sm">Save {person.name.split(" ")[0]}&apos;s details</SaveButton>
                  </SaveForm>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
