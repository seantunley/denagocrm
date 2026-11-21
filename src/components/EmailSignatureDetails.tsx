import { saveMySignatureDetails, saveSignatureRules, saveStaffSignatureDetails, sendMySignatureTest } from "@/app/actions/emailSignatures";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import SignatureVisualEditor, { type PersonDetails } from "@/components/SignatureVisualEditor";
import type { ActionResult } from "@/lib/actionResultTypes";
import type { SignatureCompany } from "@/lib/signature";
import Link from "next/link";
import SignatureNotices, { type NoticeItem } from "@/components/SignatureNotices";
import type { ReactNode } from "react";
import { LEGAL_LINE_MAX } from "@/lib/emailLegalLine";
import { SIGNATURE_LINK_KIND_LABELS, type SignatureLinkKind } from "@/lib/signatureLinks";
import { CONTACT_CARD_CHOICES, CONTACT_CARD_LABELS, type ContactCardChoice } from "@/lib/contactCard";
import {
  SIGNATURE_FIELDS, SIGNATURE_FIELD_LABELS, TEAM_LINE_MAX, missingBasics, type SignatureField, type TeamLine,
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
  legalLine,
  privacyUrl,
  trackLinks,
  contactCard,
  clicks,
  staff,
  notices,
  copy,
}: {
  /** Dated lines on now and to come (lib/signatureNotices.ts): your own, and (owner) everyone's. */
  notices: { mine: NoticeItem[]; everyone: NoticeItem[]; today: string };
  /** The owner's "Save my contact" choice (lib/contactCard.ts); undefined = off. */
  contactCard?: ContactCardChoice;
  /** Copy my signature (components/CopySignature), shown under your own signature where it is seen. */
  copy?: ReactNode;
  me: SignaturePerson;
  locked: readonly SignatureField[];
  isOwner: boolean;
  company: SignatureCompany;
  teams: { id: string; name: string }[];
  teamLines: readonly TeamLine[];
  shortReplies: boolean;
  /** The workspace's email legal line (lib/emailLegalLine.ts). */
  legalLine: string;
  privacyUrl: string;
  trackLinks: boolean;
  /** The owner's click report (lib/signatureLinkStore.ts); null for everyone else. */
  clicks: { byKind: { kind: SignatureLinkKind; clicks: number }[]; byPerson: Record<string, number>; total: number } | null;
  staff: SignaturePerson[];
}) {
  const lineFor = (teamId: string) => teamLines.find((row) => row.teamId === teamId)?.line ?? "";
  // Item 8: a signature silently drops an empty field, so tell the owner whose is missing what.
  const incomplete = staff.filter((person) => missingBasics(person).length > 0);
  const editor = (
    person: SignaturePerson,
    action: (formData: FormData) => Promise<ActionResult | void | undefined>,
    saveLabel: string,
    owner: boolean,
    testAction?: () => Promise<ActionResult | void | undefined>,
  ) => (
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
      testAction={testAction}
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
        {editor(me, saveMySignatureDetails, "Save my signature", isOwner, sendMySignatureTest)}
        {copy}
        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Dated lines</h3>
          <p className="text-xs text-muted-foreground">
            A line that shows on your signature from the first day to the last, then disappears by itself — for example while
            you are on leave. It shows on replies too.
          </p>
          <SignatureNotices items={notices.mine} forEveryone={false} today={notices.today} placeholder="e.g. On leave until 5 January — please contact Thandi on 082 555 0101" />
        </div>
      </section>

      {isOwner && (
        <section className="card space-y-3 p-5">
          <h2 className="text-base font-semibold">Dated lines for everyone</h2>
          <p className="text-xs text-muted-foreground">
            On everyone&apos;s signature from the first day to the last, then gone — holiday trading hours, a closure, a move.
            Someone&apos;s own dated line shows first.
          </p>
          <SignatureNotices items={notices.everyone} forEveryone today={notices.today} placeholder="e.g. Closed 24 Dec – 2 Jan. Workshop open 27–31 Dec, 8:00–13:00" />
        </section>
      )}

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
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="trackLinks" defaultChecked={trackLinks} className="mt-1 accent-primary" />
              <span>
                Count clicks on signature links
                <span className="block text-xs text-muted-foreground">
                  Website, WhatsApp, booking, social and privacy links on emails sent from now on go through the CRM first, so
                  you can see which ones customers use. Phone numbers and email addresses aren&apos;t counted: they open an app
                  on the customer&apos;s device, and going through a web page first would break them.
                </span>
              </span>
            </label>
            <label className="block space-y-1 text-sm">
              <span>Save my contact</span>
              <select name="contactCard" defaultValue={contactCard ?? "off"} className="input max-w-xl">
                {(["off", ...CONTACT_CARD_CHOICES] as const).map((choice) => (
                  <option key={choice} value={choice}>{CONTACT_CARD_LABELS[choice]}</option>
                ))}
              </select>
              <span className="block text-xs text-muted-foreground">
                Under everyone&apos;s signature: a customer taps it and their phone offers to add the person to their contacts
                (name, job title, numbers, email and the company&apos;s details — what the signature already shows, never the
                photo). Someone who leaves the workspace stops being handed out from their old emails.
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
              <p className="text-xs text-muted-foreground">Optional. Both are small and grey.</p>
              <label className="block space-y-1">
                <span className="text-sm">Line at the foot of every email</span>
                <textarea
                  name="legalLine"
                  defaultValue={legalLine}
                  maxLength={LEGAL_LINE_MAX}
                  rows={2}
                  placeholder="e.g. Acme (Pty) Ltd · Reg. 2015/123456/07 · VAT 4123456789. This email is confidential and meant only for the person it is addressed to."
                  className="input"
                />
                <span className="block text-xs text-muted-foreground">
                  Company details or a confidentiality notice. It goes on every email the CRM sends, not only signed ones. It is the same line as on Signature banners.
                </span>
              </label>
              <label className="block space-y-1">
                <span className="text-sm">Privacy policy link</span>
                <input name="legalPrivacyUrl" type="url" defaultValue={privacyUrl} maxLength={300} placeholder="https://…" className="input" />
                <span className="block text-xs text-muted-foreground">Shown as “Privacy policy” under everyone&apos;s signature.</span>
              </label>
            </fieldset>
            <SaveButton className="btn-primary btn-sm">Save rules</SaveButton>
          </SaveForm>
        </section>
      )}

      {isOwner && clicks && (
        <section className="card space-y-3 p-5">
          <h2 className="text-base font-semibold">Signature link clicks</h2>
          {!trackLinks && clicks.total === 0 ? (
            <p className="text-xs text-muted-foreground">Not counting yet. Tick “Count clicks on signature links” under Rules for everyone.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Clicks since counting began{trackLinks ? "" : " (counting is now off)"}. Banner clicks are on Signature banners.
              </p>
              <div className="grid gap-4 lg:grid-cols-2">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Link</th><th className="py-1 text-right font-medium">Clicks</th></tr></thead>
                  <tbody>
                    {clicks.byKind.filter((row) => row.clicks > 0).map((row) => (
                      <tr key={row.kind} className="border-t border-border/60"><td className="py-1">{SIGNATURE_LINK_KIND_LABELS[row.kind]}</td><td className="py-1 text-right tabular-nums">{row.clicks}</td></tr>
                    ))}
                    {clicks.total === 0 && <tr className="border-t border-border/60"><td className="py-1 text-muted-foreground" colSpan={2}>No clicks yet.</td></tr>}
                  </tbody>
                </table>
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-muted-foreground"><th className="py-1 font-medium">Person</th><th className="py-1 text-right font-medium">Clicks</th></tr></thead>
                  <tbody>
                    {[me, ...staff].filter((p) => (clicks.byPerson[p.id] ?? 0) > 0).sort((a, b) => (clicks.byPerson[b.id] ?? 0) - (clicks.byPerson[a.id] ?? 0)).map((p) => (
                      <tr key={p.id} className="border-t border-border/60"><td className="py-1">{p.name}</td><td className="py-1 text-right tabular-nums">{clicks.byPerson[p.id]}</td></tr>
                    ))}
                    {clicks.total === 0 && <tr className="border-t border-border/60"><td className="py-1 text-muted-foreground" colSpan={2}>No clicks yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
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
