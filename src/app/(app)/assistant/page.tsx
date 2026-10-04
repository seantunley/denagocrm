import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isCodexConnected } from "@/lib/codex";
import AssistantChat from "@/components/AssistantChat";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask the CRM" };

export default async function AssistantPage() {
  await requireAnyPermission(
    "leads.view_all", "leads.view_owned",
    "quotes.view_all", "quotes.view_owned",
    "activities.view", "activities.manage",
  );
  if (!(await isModuleEnabled("automation"))) notFound();
  const connected = await isCodexConnected();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Ask the CRM"
        description="Plain-language questions about your leads, quotes and activities — answered from your own records, never more than your lists show you."
      />
      {connected ? (
        <AssistantChat />
      ) : (
        <p className="card p-5 text-sm text-muted-foreground">
          This runs on your workspace&apos;s ChatGPT connection, which isn&apos;t set up yet.{" "}
          <Link href="/settings/integrations" className="text-primary underline">Connect ChatGPT</Link> to start asking.
        </p>
      )}
    </div>
  );
}
