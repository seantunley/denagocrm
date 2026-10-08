import Link from "next/link";
import { PenLine } from "lucide-react";
import { ensureEmailTemplates } from "@/lib/doceditor/emailSeeding";
import { EMAIL_FRAME_KEY, emailBodyKey } from "@/lib/doceditor/emailDefaults";
import { SIGNING_EMAILS, type SigningEmailKind } from "@/lib/signing/emailTemplates";

/**
 * The customer EMAILS of one place (Document Studio, Journeys → Customer
 * messages, Settings), each opening in the document editor like a document
 * does (Sean, 2026-10-08). With `frame`, the shared frame comes first, and
 * while it is unpublished every card says so: until then customers get the
 * emails as they are today.
 *
 * Owner-only — the editor's own rule for email layouts (layoutAccess.ts) — so
 * the caller renders it only for the workspace owner.
 */
export default async function EmailDesignCards({ kinds, frame = false }: { kinds: SigningEmailKind[]; frame?: boolean }) {
  const rows = await ensureEmailTemplates();
  const frameRow = rows.get(EMAIL_FRAME_KEY);
  const frameLive = frameRow?.publishedVersion != null;

  const card = (id: string, anchor: string, title: string, description: string, live: boolean, note?: string) => (
    <div key={anchor} id={anchor} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 scroll-mt-24">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {title}
          <span className={`ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide ${live ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>
            {live ? "Published" : "Not published yet"}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        {note && <p className="mt-1 text-xs text-amber-600">{note}</p>}
      </div>
      <Link href={`/doc-editor/${id}`} className="btn-primary btn-sm inline-flex shrink-0 items-center gap-1.5">
        <PenLine className="size-3.5" />
        Edit email
      </Link>
    </div>
  );

  return (
    <div className="space-y-3">
      {frame && frameRow &&
        card(
          frameRow.id,
          "template-frame",
          "Email frame — header, signature and footer",
          "Shared by every customer email: your logo panel, the sender's signature and your company details. Each email below is its message inside this frame.",
          frameLive,
          frameLive ? undefined : "Customers get your emails as they are today until you publish the frame.",
        )}
      {kinds.map((kind) => {
        const row = rows.get(emailBodyKey(kind));
        if (!row) return null;
        const def = SIGNING_EMAILS[kind];
        return card(
          row.id,
          `template-${kind}`,
          def.label,
          def.description,
          row.publishedVersion != null,
          !frameLive ? undefined : row.publishedVersion == null ? "Not published: customers get today's wording in the new frame." : undefined,
        );
      })}
    </div>
  );
}
