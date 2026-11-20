"use client";

import { useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";
import { buildEmailHtml, buildSignature, type SignatureCompany } from "@/lib/signature";
import { SIGNATURE_FIELDS, SIGNATURE_FIELD_LABELS, cleanDetail, mayEdit, type SignatureField } from "@/lib/signaturePeople";

type TextField = Exclude<SignatureField, "photo">;
const TEXT_FIELDS = SIGNATURE_FIELDS.filter((field): field is TextField => field !== "photo");

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

const PLACEHOLDER: Record<TextField, string> = {
  qualifications: "e.g. BCom (Hons), CA(SA)",
  directLine: "e.g. 021 555 1234",
  whatsapp: "e.g. 082 555 1234",
  bookingUrl: "https://… (your calendar booking page)",
  hours: "e.g. Mon–Fri 8:00–17:00",
};

/**
 * The visual signature editor (item 2 of email-signature-improvements.md — "a visual editor in place of raw HTML"):
 * the details on the left, the signature they make on the right, redrawn as you type by the same function the send
 * uses. A detail shows on the signature only when filled in; a detail the owner locked is shown greyed with a padlock
 * and is not sent, so the server leaves it as it is (app/actions/emailSignatures.ts checks again).
 */
export default function SignatureVisualEditor({
  person,
  initial,
  locked,
  isOwner,
  company,
  teamLine,
  customHtmlInUse,
  action,
  saveLabel,
}: {
  person: { id: string; name: string; email: string; mobile: string | null; jobTitle: string | null };
  initial: PersonDetails;
  locked: readonly SignatureField[];
  /** The workspace owner may change every detail, for anyone. */
  isOwner: boolean;
  company: SignatureCompany;
  teamLine: string;
  /** Their own HTML replaces this signature on their emails until it is cleared. */
  customHtmlInUse: boolean;
  action: (formData: FormData) => Promise<ActionResult | void | undefined>;
  saveLabel: string;
}) {
  const [values, setValues] = useState<Record<TextField, string>>(() =>
    Object.fromEntries(TEXT_FIELDS.map((field) => [field, initial[field] ?? ""])) as Record<TextField, string>,
  );
  const [photo, setPhoto] = useState(initial.photo);
  const problem = (field: TextField) => {
    const result = cleanDetail(field, values[field]);
    return result.ok ? "" : result.error;
  };
  // The preview photo is read from this app (the srcdoc frame shares the page's address), never a public link.
  const extras = {
    ...Object.fromEntries(TEXT_FIELDS.map((field) => [field, problem(field) ? "" : values[field].trim()])),
    photoUrl: photo && initial.hasPhoto ? `/api/signature-photo/${person.id}` : null,
  };
  const preview = buildEmailHtml("", buildSignature({ ...person, signatureHtml: null, extras, teamLine }, company));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SaveForm action={action} resetOnSuccess={false} success="Saved" className="space-y-3">
        {TEXT_FIELDS.map((field) => {
          const editable = mayEdit(field, locked, isOwner);
          const error = editable ? problem(field) : "";
          return (
            <label key={field} className="block space-y-1">
              <span className="label flex items-center gap-1.5">
                {SIGNATURE_FIELD_LABELS[field]}
                {!editable && <Lock className="h-3 w-3" aria-label="Set by the workspace owner" />}
              </span>
              {editable ? (
                <input
                  name={field}
                  value={values[field]}
                  onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
                  placeholder={PLACEHOLDER[field]}
                  className="input"
                  maxLength={field === "bookingUrl" ? 300 : 120}
                  aria-invalid={Boolean(error)}
                />
              ) : (
                <input value={values[field] || "—"} readOnly disabled className="input opacity-60" />
              )}
              {error && <span className="block text-xs text-red-500">{error}</span>}
              {!editable && <span className="block text-xs text-muted-foreground">Set by the workspace owner.</span>}
            </label>
          );
        })}
        {mayEdit("photo", locked, isOwner) ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="hidden" name="photoShown" value="1" />
            <input
              type="checkbox"
              name="photo"
              checked={photo}
              onChange={(e) => setPhoto(e.target.checked)}
              className="mt-1 accent-primary"
              disabled={!initial.hasPhoto && !photo}
            />
            <span>
              Show the profile photo
              {!initial.hasPhoto && (
                <span className="block text-xs text-muted-foreground">
                  No profile photo yet. Add one in <Link href="/settings?tab=account" className="underline">Settings → My account</Link> first.
                </span>
              )}
            </span>
          </label>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden /> Photo {photo ? "on" : "off"}, set by the workspace owner.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Name, job title and mobile come from Settings → My account. Each detail shows only when it is filled in.
        </p>
        <SaveButton className="btn-primary btn-sm">{saveLabel}</SaveButton>
      </SaveForm>
      <div className="space-y-2">
        <div className="text-sm font-medium">How it looks</div>
        {customHtmlInUse && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            Your own HTML signature is in use instead of this one. Clear it under “Advanced” to use this signature.
          </p>
        )}
        {/* As a mail app shows it: a frame the page's styles can't reach, no scripts. */}
        <iframe
          title={`${person.name}'s signature`}
          sandbox="allow-same-origin"
          srcDoc={preview}
          onLoad={(e) => {
            const doc = e.currentTarget.contentDocument;
            if (doc) e.currentTarget.style.height = `${doc.documentElement.scrollHeight + 4}px`;
          }}
          className="w-full rounded-lg border border-border bg-white"
          style={{ height: 240 }}
        />
      </div>
    </div>
  );
}
