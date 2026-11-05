import Link from "next/link";
import { Bell, Eye, AtSign } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { unreadNotificationCount, visibleNotifications } from "@/lib/collaboration";
import { formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/visual-system";
import MarkNotificationsSeen from "@/components/MarkNotificationsSeen";

export const dynamic = "force-dynamic";

/**
 * The bell: where you were @mentioned, and what changed on records you watch. Only what you may still open is shown
 * — losing access to a customer hides what was said about them.
 */
export default async function NotificationsPage() {
  const user = await requireUser();
  const tenantId = await actingTenantId();
  const [rows, unreadCount] = await Promise.all([visibleNotifications(user, tenantId), unreadNotificationCount(tenantId, user.id)]);

  return (
    <div className="space-y-5">
      {/* Opening the page reads them all — including any about a record you can no longer open, so the bell clears. */}
      <MarkNotificationsSeen unread={unreadCount} />
      <PageHeader title="Notifications" description="Where your team @mentioned you, and changes on records you watch." />
      {rows.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="Nothing yet"
          description="Type @ in a note to mention someone, or press Watch on a deal, customer or job card to hear about its changes."
        />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {rows.map((row) => {
            const Icon = row.kind === "mention" ? AtSign : Eye;
            return (
              <li key={row.id} className={row.readAt ? "" : "bg-primary/[0.04]"}>
                <Link href={row.href} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${row.readAt ? "" : "font-semibold"}`}>{row.title}</span>
                    {row.snippet && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.snippet}</span>}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{formatDateTime(row.createdAt)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
