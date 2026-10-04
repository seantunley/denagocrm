import Link from "next/link";
import { requireTenantOwner } from "@/lib/auth";
import { SettingsWorkspace, SettingsSection } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import { StatusPill } from "@/components/visual-system";
import { loadQueueHealth } from "@/lib/queueHealth";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

const FAILED = new Set(["dead", "failed", "failed_permanent", "blocked"]);
const DONE = new Set(["sent", "delivered", "completed", "done", "signed"]);

/**
 * Background queues (gap audit #34): signing jobs, customer messages, campaign
 * sends, survey invitations and journey runs — their state and their latest
 * failures, which otherwise only showed in the 30-day error log.
 */
export default async function QueuesSettingsPage() {
  await requireTenantOwner();
  const queues = await loadQueueHealth();

  return (
    <SettingsWorkspace
      current="queues"
      title="Background queues"
      description="Work the CRM does in the background. Last 7 days by status, anything overdue, and the most recent failures — each linked to where it can be fixed."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-6">
        {queues.map((queue) => (
          <SettingsSection
            key={queue.key}
            title={queue.label}
            description={queue.description}
            action={
              queue.stuck > 0 ? (
                <StatusPill tone="danger">{queue.stuck} overdue</StatusPill>
              ) : queue.failures.length > 0 ? (
                <StatusPill tone="warning">{queue.failures.length} recent failure{queue.failures.length === 1 ? "" : "s"}</StatusPill>
              ) : (
                <StatusPill tone="success">Healthy</StatusPill>
              )
            }
          >
            {queue.counts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing in the last 7 days.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {queue.counts.map((count) => (
                  <StatusPill key={count.status} tone={FAILED.has(count.status) ? "danger" : DONE.has(count.status) ? "success" : "neutral"}>
                    {count.status.replaceAll("_", " ")} · {count.count}
                  </StatusPill>
                ))}
              </div>
            )}
            {queue.stuck > 0 && (
              <p className="mt-3 text-xs text-red-300">
                {queue.stuck} item{queue.stuck === 1 ? " is" : "s are"} more than 15 minutes past due, or started and never finished — the background worker may have stopped.
              </p>
            )}
            {queue.failures.length > 0 && (
              <ul className="mt-4 divide-y divide-border">
                {queue.failures.map((failure) => (
                  <li key={failure.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
                    <span className="text-xs text-muted-foreground">{formatDateTime(failure.at)}</span>
                    <span className="min-w-0 flex-1">{failure.detail}</span>
                    {failure.href && <Link href={failure.href} className="text-xs text-primary hover:underline">Open</Link>}
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
        ))}
      </div>
    </SettingsWorkspace>
  );
}
