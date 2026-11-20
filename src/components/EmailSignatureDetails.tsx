import { saveMySignatureDetails, saveSignatureRules, saveStaffSignatureDetails } from "@/app/actions/emailSignatures";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import SignatureVisualEditor, { type PersonDetails } from "@/components/SignatureVisualEditor";
import type { ActionResult } from "@/lib/actionResultTypes";
import type { SignatureCompany } from "@/lib/signature";
import { SIGNATURE_FIELDS, SIGNATURE_FIELD_LABELS, TEAM_LINE_MAX, type SignatureField, type TeamLine } from "@/lib/signaturePeople";

export type { PersonDetails };

export type SignaturePerson = PersonDetails & {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  jobTitle: string | null;
  teamLine: string;
  customHtmlInUse: boolean;
};

/**
 * The Email signatures pack's people settings (items 1–4): your own signature in the visual editor; for the owner, the
 * rules (locked details, a line per team, short replies) and every team member in the same editor.
 */
export default function EmailSignatureDetails({
  me,
  locked,
  isOwner,
  company,
  teams,
  teamLines,
  shortReplies,
  staff,
}: {
  me: SignaturePerson;
  locked: readonly SignatureField[];
  isOwner: boolean;
  company: SignatureCompany;
  teams: { id: string; name: string }[];
  teamLines: readonly TeamLine[];
  shortReplies: boolean;
  staff: SignaturePerson[];
}) {
  const lineFor = (teamId: string) => teamLines.find((row) => row.teamId === teamId)?.line ?? "";
  const editor = (person: SignaturePerson, action: (formData: FormData) => Promise<ActionResult | void | undefined>, saveLabel: string, owner: boolean) => (
    <SignatureVisualEditor
      person={{ id: person.id, name: person.name, email: person.email, mobile: person.mobile, jobTitle: person.jobTitle }}
      initial={person}
      locked={locked}
      isOwner={owner}
      company={company}
      teamLine={person.teamLine}
      customHtmlInUse={person.customHtmlInUse}
      action={action}
      saveLabel={saveLabel}
    />
  );
  return (
    <div className="space-y-6">
      <section className="card space-y-3 p-5">
        <h2 className="text-base font-semibold">Your signature</h2>
        {editor(me, saveMySignatureDetails, "Save my signature", isOwner)}
      </section>

      {isOwner && (
        <section className="card space-y-3 p-5">
          <h2 className="text-base font-semibold">Rules for everyone</h2>
          <SaveForm action={saveSignatureRules} resetOnSuccess={false} success="Saved" className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Details staff can&apos;t change</legend>
              <p className="text-xs text-muted-foreground">Ticked details are set by you, for each person, under Your team. Unticked, people set their own.</p>
              <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
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
                <p className="text-xs text-muted-foreground">No teams yet. Add them in Settings → Team &amp; access.</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Shown under the signature of everyone in that team. Someone in two teams gets the first that is theirs.</p>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {teams.map((team) => (
                      <label key={team.id} className="block space-y-1">
                        <span className="text-sm">{team.name}</span>
                        <input name={`team_${team.id}`} defaultValue={lineFor(team.id)} maxLength={TEAM_LINE_MAX} placeholder="e.g. Workshop: Mon–Fri 8:00–17:00 · Parts 021 555 1234" className="input" />
                      </label>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
            <SaveButton className="btn-primary btn-sm">Save rules</SaveButton>
          </SaveForm>
        </section>
      )}

      {isOwner && staff.length > 0 && (
        <section className="card space-y-3 p-5">
          <h2 className="text-base font-semibold">Your team</h2>
          <p className="text-xs text-muted-foreground">Open a person to set any of their details, including the ones staff can&apos;t change themselves.</p>
          <ul className="divide-y divide-border/60">
            {staff.map((person) => (
              <li key={person.id} className="py-2">
                <details>
                  <summary className="cursor-pointer text-sm">
                    {person.name} <span className="text-muted-foreground">· {person.email}</span>
                  </summary>
                  <div className="mt-3">{editor(person, saveStaffSignatureDetails.bind(null, person.id), `Save ${person.name.split(" ")[0]}'s signature`, true)}</div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
