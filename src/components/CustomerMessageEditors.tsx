import { basePrisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/auth";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import { EmailTemplateEditor, SmsTemplateEditor } from "@/components/settings/EmailTemplateEditor";
import { sanitizeEmailDoc, textToEmailDoc } from "@/lib/signing/emailDoc";
import {
  SIGNING_EMAILS,
  SIGNING_FIELD_HELP,
  isTextTemplate,
  parseEmailHeaderStyle,
  parseStoredSigningTemplate,
  type SigningEmailKind,
} from "@/lib/signing/emailTemplates";
import { saveSigningEmailTemplate, resetSigningEmailTemplate, previewSigningEmailTemplate } from "@/app/actions/emails";

/**
 * The editors for a set of customer messages (signing, quote, reminder, survey
 * … emails and texts), wherever they are shown — Document Studio, Journeys →
 * Customer messages, Settings → Email (lib/customerMessagePlaces.ts). One
 * component, so the three places can't drift into three different editors.
 *
 * Owner-only, like the actions behind it (requireTenantOwner): the caller
 * renders it only for the workspace owner.
 *
 * The edited copies are read by EXPLICIT tenant — the same key the send path
 * reads by the message's tenantId (lib/signing/signingEmail.ts).
 */
export default async function CustomerMessageEditors({
  kinds,
  open,
}: {
  kinds: SigningEmailKind[];
  /** ?open=<kind>: the one to open (linked from Automatic jobs & messages and the journey builder). */
  open?: string | null;
}) {
  const tenantId = await getActiveTenantId();
  const overrides = tenantId
    ? await basePrisma.appSetting.findMany({
        where: { tenantId, key: { in: [...kinds.map((k) => SIGNING_EMAILS[k].settingKey), "EMAIL_HEADER_STYLE"] } },
        select: { key: true, value: true },
      })
    : [];
  const saved = (kind: SigningEmailKind) =>
    parseStoredSigningTemplate(overrides.find((s) => s.key === SIGNING_EMAILS[kind].settingKey)?.value, kind);
  // The previews re-render when the header style changes.
  const headerStyle = parseEmailHeaderStyle(overrides.find((s) => s.key === "EMAIL_HEADER_STYLE")?.value);
  const groups = [...new Set(kinds.map((k) => SIGNING_EMAILS[k].group))];

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group}>
          {groups.length > 1 && (
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{group}</div>
          )}
          <div className="space-y-3">
            {kinds
              .filter((k) => SIGNING_EMAILS[k].group === group)
              .map((kind) => {
                const def = SIGNING_EMAILS[kind];
                const copy = saved(kind);
                return (
                  <details key={kind} id={`template-${kind}`} open={open === kind} className="rounded-lg border border-border bg-muted/40 scroll-mt-24">
                    <summary className="px-4 py-2.5 cursor-pointer text-sm font-medium flex items-center gap-2">
                      {def.label}
                      <span className="badge bg-muted text-muted-foreground">
                        {def.channel === "sms" ? "SMS" : def.channel === "whatsapp" ? "WhatsApp" : "Email"}
                      </span>
                      <span className="badge bg-muted text-muted-foreground">{copy ? "Customised" : "Default"}</span>
                    </summary>
                    <div className="p-4 pt-1 space-y-2">
                      <p className="text-xs text-muted-foreground">{def.description}</p>
                      <SaveForm
                        // Remount after a reset so the fields show the default again.
                        key={copy ? "custom" : "default"}
                        success={`${def.label} saved`}
                        resetOnSuccess={false}
                        action={saveSigningEmailTemplate.bind(null, kind)}
                        className="space-y-2"
                      >
                        {isTextTemplate(def) ? (
                          <SmsTemplateEditor
                            initialBody={copy?.body ?? def.body}
                            fields={def.fields}
                            fieldHelp={SIGNING_FIELD_HELP}
                            requiredField={def.action}
                            preview={previewSigningEmailTemplate.bind(null, kind)}
                            whatsapp={def.channel === "whatsapp"}
                          />
                        ) : (
                          <EmailTemplateEditor
                            initialSubject={copy?.subject ?? def.subject}
                            initialDoc={
                              (copy?.doc ? sanitizeEmailDoc(copy.doc, def.fields) : null) ?? textToEmailDoc(copy?.body ?? def.body, def.fields)
                            }
                            fields={def.fields}
                            fieldHelp={SIGNING_FIELD_HELP}
                            requiredField={def.action}
                            preview={previewSigningEmailTemplate.bind(null, kind)}
                            refreshKey={headerStyle}
                          />
                        )}
                        <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                      </SaveForm>
                      {copy && (
                        <SaveForm success="Reset to default" action={resetSigningEmailTemplate.bind(null, kind)}>
                          <SaveButton className="btn-secondary btn-sm">Reset to default</SaveButton>
                        </SaveForm>
                      )}
                    </div>
                  </details>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
