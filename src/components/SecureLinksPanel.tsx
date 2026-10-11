import { Link2 } from "lucide-react";
import { getActiveTenantId, getCurrentUser } from "@/lib/auth";
import { CUSTOMER_RECORD_WRITE_PERMISSIONS, hasAnyPermission } from "@/lib/permissions";
import { formatDateTime } from "@/lib/format";
import { fileSizeLabel, secureLinkSummary } from "@/lib/secureLinks";
import { secureLinksFor } from "@/lib/secureLinkStore";
import { StatusPill } from "@/components/visual-system";
import SecureLinkRecall from "@/components/SecureLinkRecall";

/**
 * The files sent to this customer as secure links (lib/secureLinks.ts): which
 * still work, which were downloaded and when, and the Recall button — here, on
 * the record, because this is where someone realises a file went to the wrong
 * person. Renders nothing until a secure link has been sent.
 *
 * The page it sits on has already decided the viewer may open this record; the
 * rows are read by workspace as well, and the recall action checks both again.
 */
export default async function SecureLinksPanel({ contactId, leadId }: { contactId?: string; leadId?: string }) {
  const tenantId = await getActiveTenantId();
  if (!tenantId || (!contactId && !leadId)) return null;
  const links = await secureLinksFor(tenantId, leadId ? { leadId } : { contactId: contactId! });
  if (links.length === 0) return null;
  // Recall is offered to whoever could have sent it — the same permission the action checks.
  const user = await getCurrentUser();
  const canRecall = Boolean(user) && (await hasAnyPermission(user!, ...CUSTOMER_RECORD_WRITE_PERMISSIONS));
  const now = new Date();

  return (
    <section className="card p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Link2 className="size-4 text-primary" aria-hidden />
        Files sent as secure links
      </h3>
      <ul className="mt-2 divide-y divide-border/60">
        {links.map((link) => {
          const summary = secureLinkSummary(link, now, formatDateTime);
          return (
            <li key={link.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
              <div className="min-w-0 flex-1 basis-64">
                <p className="truncate font-medium text-foreground">
                  {link.fileName}
                  {fileSizeLabel(link.sizeBytes) && <span className="ml-2 text-xs font-normal text-muted-foreground">{fileSizeLabel(link.sizeBytes)}</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">To {link.sentTo} · sent {formatDateTime(link.createdAt)}</p>
              </div>
              <StatusPill tone={link.firstOpenedAt ? "success" : "neutral"}>{summary.opened}</StatusPill>
              <StatusPill tone={summary.state === "active" ? "info" : summary.state === "recalled" ? "danger" : "warning"}>{summary.status}</StatusPill>
              {canRecall && summary.state === "active" && <SecureLinkRecall id={link.id} fileName={link.fileName} />}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        “Downloaded” means someone holding the link pressed Download. It does not prove who. Anyone the link is forwarded to can use it until it expires or is recalled.
      </p>
    </section>
  );
}
