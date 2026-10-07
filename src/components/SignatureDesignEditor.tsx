"use client";

import { useState } from "react";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { saveSignatureDesign } from "@/app/actions/emails";
import { buildEmailHtml, buildSignature, SIGNATURE_LINE_MAX, type SignatureCompany, type SignatureDesign } from "@/lib/signature";

/**
 * Settings → My account → Email signature, for the workspace owner: the ONE
 * signature design everyone's email carries, with a live preview built by the
 * same function the send uses. Everyone else sees the preview only.
 */
export default function SignatureDesignEditor({
  user,
  company,
  initial,
  canEdit,
}: {
  user: { name: string; email: string; mobile?: string | null; jobTitle?: string | null };
  company: SignatureCompany;
  initial: SignatureDesign;
  canEdit: boolean;
}) {
  const [design, setDesign] = useState(initial);
  const set = (patch: Partial<SignatureDesign>) => setDesign((d) => ({ ...d, ...patch }));
  const defaultFooter = [company.tagline, company.address.replace(/&amp;/g, "&")].map((s) => s.trim()).filter(Boolean).join(" — ");

  return (
    <div className="space-y-4">
      {/* A frame, as a mail client shows it: the browser's table fix-ups (an
          inserted <tbody>) can't make server and client markup disagree, and the
          page's styles can't leak in. sandbox without scripts; same-origin only
          so the frame can be sized to its content. The preview ignores a personal
          custom HTML signature on purpose: this is the design being edited. */}
      <iframe
        title="Signature preview"
        sandbox="allow-same-origin"
        srcDoc={buildEmailHtml("", buildSignature({ ...user, signatureHtml: null }, { ...company, design }))}
        onLoad={(e) => {
          const doc = e.currentTarget.contentDocument;
          if (doc) e.currentTarget.style.height = `${doc.documentElement.scrollHeight + 4}px`;
        }}
        className="w-full rounded-lg border border-border bg-white"
        style={{ height: 220 }}
      />
      {canEdit ? (
        <SaveForm success="Signature saved for everyone" resetOnSuccess={false} action={saveSignatureDesign} className="space-y-3 max-w-xl">
          <p className="text-xs text-muted-foreground">
            One design for everyone in the workspace. Each person&apos;s name, job title and mobile come from their own
            My account; the logo, website, phone and address from Company profile.
          </p>
          <div>
            <label className="label" htmlFor="sig-style">Design</label>
            <select
              id="sig-style"
              name="style"
              className="input"
              value={design.style}
              onChange={(e) => set({ style: e.target.value === "classic" ? "classic" : "card" })}
            >
              <option value="card">Card — logo panel, round icons, address line</option>
              <option value="classic">Classic — logo above, socials row</option>
            </select>
          </div>
          {design.style === "card" && (
            <>
              <div>
                <label className="label" htmlFor="sig-company">Line under the name</label>
                <input
                  id="sig-company"
                  name="companyLine"
                  className="input"
                  maxLength={SIGNATURE_LINE_MAX}
                  value={design.companyLine}
                  placeholder={company.name}
                  onChange={(e) => set({ companyLine: e.target.value })}
                />
              </div>
              <div>
                <label className="label" htmlFor="sig-footer">Footer line</label>
                <input
                  id="sig-footer"
                  name="footerLine"
                  className="input"
                  maxLength={SIGNATURE_LINE_MAX}
                  value={design.footerLine}
                  placeholder={defaultFooter}
                  onChange={(e) => set({ footerLine: e.target.value })}
                />
                <p className="mt-1 text-xs text-muted-foreground">Leave a line empty to use the Company profile&apos;s.</p>
              </div>
            </>
          )}
          {design.style === "classic" && (
            <>
              <input type="hidden" name="companyLine" value={design.companyLine} />
              <input type="hidden" name="footerLine" value={design.footerLine} />
            </>
          )}
          <SaveButton className="btn-primary btn-sm">Save for everyone</SaveButton>
        </SaveForm>
      ) : (
        <p className="text-xs text-muted-foreground">
          Your name, job title and mobile come from My account. The rest of the design is set by the workspace owner.
        </p>
      )}
    </div>
  );
}
