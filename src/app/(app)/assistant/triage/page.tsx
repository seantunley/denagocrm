import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isCodexConnected } from "@/lib/codex";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { loadTriage } from "@/lib/assistantTriage";
import TriageBoard from "@/components/TriageBoard";

export const dynamic = "force-dynamic";

/**
 * DAX TRIAGE: the deals waiting on you, what's holding each up, and what DAX would do — you tick what to do, it does
 * those through the CRM's own actions, and a message to a customer still goes only from its own Send button.
 */
export default async function TriagePage() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) notFound();
  const [connected, run] = await Promise.all([isCodexConnected(), loadTriage(user)]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Work through who's waiting"
        description="DAX goes through the deals that need you — customers waiting for a reply, overdue follow-ups, quotes about to expire — says what's holding each up, and prepares replies, follow-ups and hand-overs. Nothing happens until you tick it; messages only go when you press Send."
      >
        <Link href="/assistant" className="btn-secondary btn-sm">Back to Ask</Link>
      </PageHeader>
      {!connected ? (
        <p className="card p-5 text-sm text-muted-foreground">
          This runs on your workspace&apos;s AI connection, which isn&apos;t set up yet.{" "}
          <Link href="/settings/integrations" className="text-primary underline">Connect an AI service</Link>.
        </p>
      ) : (
        <TriageBoard run={run ? { ...run, items: run.items.map((item) => ({ ...item, cards: item.cards.map((c) => ({ ...c, card: { id: c.card.id, kind: c.card.kind, title: c.card.title, reason: "reason" in c.card ? c.card.reason ?? null : null, ...(c.card.kind === "draft_message" ? { channel: c.card.channel, subject: c.card.subject ?? null, body: c.card.body } : {}) } })) })) } : null} />
      )}
    </div>
  );
}
