import { saveMySignatureDetails, saveSignatureRules, saveStaffSignatureDetails } from "@/app/actions/emailSignatures";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import SignatureVisualEditor, { type PersonDetails } from "@/components/SignatureVisualEditor";
import type { ActionResult } from "@/lib/actionResultTypes";
import type { SignatureCompany } from "@/lib/signature";
import Link from "next/link";
import {
  LEGAL_LINE_MAX, LEGAL_NOTICE_MAX, SIGNATURE_FIELDS, SIGNATURE_FIELD_LABELS, TEAM_LINE_MAX, missingBasics,
  type SignatureField, type SignatureLegal, type TeamLine,
} from "@/lib/signaturePeople";

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
  legal,
  staff,
}: {
  me: SignaturePerson;
  locked: readonly SignatureField[];
  isOwner: boolean;
  company: SignatureCompany;
  teams: { id: string; name: string }[];
  teamLines: readonly TeamLine[];
  shortReplies: boolean;
  legal: SignatureLegal;
  staff: SignaturePerson[];
}) {
  const lineFor = (teamId: string) => teamLines.find((row) => row.teamId === teamId)?.line ?? "";
  // Item 8: a signature silently drops an empty field, so tell the owner whose is missing what.
  const incomplete = staff.filter((person) => missingBasics(person).length > 0);
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
        {missingBasics(me).length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Your signature has no {missingBasics(me).join(" or ")}. Add it in{" "}
            <Link href="/settings?tab=account" className="underline">Settings → My account</Link>.
          </p>
        )}
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
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Small print under every signature</legend>
              <p className="text-xs text-muted-foreground">Optional. Shown small and grey under everyone&apos;s signature, on new emails and replies.</p>
              <div className="grid gap-3 lg:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-sm">Company details</span>
                  <input name="legalCompanyLine" defaultValue={legal.companyLine} maxLength={LEGAL_LINE_MAX} placeholder="e.g. Acme (Pty) Ltd · Reg. 2015/123456/07 · VAT 4123456789" className="input" />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">Privacy policy link</span>
                  <input name="legalPrivacyUrl" type="url" defaultValue={legal.privacyUrl} maxLength={300} placeholder="https://…" className="input" />
                </label>
              </div>
              <label className="block space-y-1">
                <span className="text-sm">Confidentiality notice</span>
                <textarea name="legalNotice" defaultValue={legal.notice} maxLength={LEGAL_NOTICE_MAX} rows={3} placeholder="e.g. This email and its attachments are confidential and meant only for the person it is addressed to." className="input" />
              </label>
            </fieldset>
            <SaveButton className="btn-primary btn-sm">Save rules</SaveButton>
          </SaveForm>
        </section>
      )}

      {isOwner && staff.length > 0 && (
        <section className="card space-y-3 p-5">
          <h2 className="text-base font-semibold">Your team</h2>
          <p className="text-xs text-muted-foreground">Open a person to set any of their details, including the ones staff can&apos;t change themselves.</p>
          {incomplete.length > 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {incomplete.length === 1 ? "1 person's signature is" : `${incomplete.length} people's signatures are`} missing details, so
              those lines are left out: {incomplete.map((p) => `${p.name} (${missingBasics(p).join(", ")})`).join("; ")}. Each person adds
              their job title and mobile in Settings → My account.
            </p>
          )}
          <ul className="divide-y divide-border/60">
            {staff.map((person) => (
              <li key={person.id} className="py-2">
                <details>
                  <summary className="cursor-pointer text-sm">
                    {person.name} <span className="text-muted-foreground">· {person.email}</span>
                    {missingBasics(person).length > 0 && (
                      <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">no {missingBasics(person).join(" or ")}</span>
                    )}
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
