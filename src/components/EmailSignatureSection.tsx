import Link from "next/link";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import SignatureDesignEditor from "@/components/SignatureDesignEditor";
import { saveMyProfile } from "@/app/actions/settings";
import { buildSignature, type SignatureCompany, type SignatureDesign } from "@/lib/signature";
import type { SignatureExtras } from "@/lib/signaturePeople";

/**
 * The email signature: the workspace design (the owner edits it), how it looks on this person's emails, and their own
 * HTML override. One section for both places it appears — Settings → My account while the Email signatures pack is
 * off, and the pack's own page when it is on (2026-11-20) — so the two can never drift apart.
 */
export default function EmailSignatureSection({
  user,
  company,
  design,
  canEditDesign,
  bannersHref,
  details,
  designPreview = true,
  moreDesigns = false,
}: {
  user: { name: string; email: string; mobile: string | null; jobTitle: string | null; signatureHtml: string | null };
  company: SignatureCompany;
  design: SignatureDesign;
  canEditDesign: boolean;
  /** Where the owner manages banners; null when banners aren't available (the pack is off). */
  bannersHref: string | null;
  /** The person's own details and team line, so the preview is their real signature (the Email signatures pack). */
  details?: { extras?: SignatureExtras; teamLine?: string };
  /** The design and its preview. Off on the pack's page for staff: their visual editor already shows the signature. */
  designPreview?: boolean;
  /** The pack's extra designs; only its own page offers them (the pack is on there). */
  moreDesigns?: boolean;
}) {
  return (
    <div className="space-y-4">
      {designPreview && (
        <SignatureDesignEditor
          user={{ name: user.name, email: user.email, mobile: user.mobile, jobTitle: user.jobTitle, ...details }}
          company={company}
          initial={design}
          canEdit={canEditDesign}
          moreDesigns={moreDesigns}
        />
      )}
      {canEditDesign && bannersHref && (
        <p className="text-xs text-muted-foreground">
          Want a promotion under the signature? Add a marketing banner, with dates, on{" "}
          <Link href={bannersHref} className="text-primary hover:underline">Signature banners</Link>.
        </p>
      )}
      {/* Custom HTML replaces the whole branded signature: the owner's alone (saveMyProfile refuses anyone else). */}
      {/* Anyone who already has one still sees it, to clear it. */}
      {(canEditDesign || Boolean(user.signatureHtml?.trim())) && (
      <details className="rounded-lg border border-border">
        <summary className="px-4 py-2.5 cursor-pointer text-sm text-muted-foreground">
          Advanced: use your own HTML instead{user.signatureHtml?.trim() ? " (in use on your emails)" : ""}
        </summary>
        <div className="px-4 pb-4 space-y-3">
          {user.signatureHtml?.trim() && (
            <div className="rounded-lg bg-white p-4 overflow-x-auto" dangerouslySetInnerHTML={{ __html: buildSignature(user, company) }} />
          )}
          <SaveForm success="Profile saved" resetOnSuccess={false} action={saveMyProfile} className="space-y-3 max-w-md">
            <div>
              <label className="label">Custom signature HTML (optional)</label>
              <textarea
                name="signatureHtml"
                className="input font-mono text-xs"
                rows={4}
                defaultValue={user.signatureHtml ?? ""}
                placeholder="Leave blank to use the workspace signature (recommended)."
              />
              <p className="mt-1 text-xs text-muted-foreground">Replaces the workspace signature on your emails only.</p>
            </div>
            <SaveButton className="btn-primary btn-sm">Save</SaveButton>
          </SaveForm>
        </div>
      </details>
      )}
    </div>
  );
}
