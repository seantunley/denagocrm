import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isCodexConnected } from "@/lib/codex";
import { getSetting } from "@/lib/settings";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { assistantHistory } from "@/lib/crmAssistant";
import AssistantChat from "@/components/AssistantChat";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { deleteAssistantNote } from "@/app/actions/assistantNotes";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask the CRM" };

export default async function AssistantPage() {
  const user = await requireAnyPermission(
    "leads.view_all", "leads.view_owned",
    "quotes.view_all", "quotes.view_owned",
    "activities.view", "activities.manage",
  );
  if (!(await isModuleEnabled("automation"))) notFound();
  const [connected, profile, history, aboutMe] = await Promise.all([
    isCodexConnected(),
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    assistantHistory(user.id),
    prisma.assistantNote.findMany({ where: { kind: "profile", userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true, content: true } }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={profile.name === "Assistant" ? "Ask the CRM" : `Ask ${profile.name}`}
        description="Your sales colleague: it reads your leads, quotes, activities and the business's own knowledge, and tells you what it means — never more than your own lists show you."
      />
      {connected ? (
        <AssistantChat name={profile.name} history={history.map(({ question, answer }) => ({ question, answer }))} />
      ) : (
        <p className="card p-5 text-sm text-muted-foreground">
          This runs on your workspace&apos;s ChatGPT connection, which isn&apos;t set up yet.{" "}
          <Link href="/settings/integrations" className="text-primary underline">Connect ChatGPT</Link> to start asking.
        </p>
      )}
      {aboutMe.length > 0 && (
        <details className="card p-4 text-sm">
          <summary className="cursor-pointer font-medium">What {profile.name} remembers about you ({aboutMe.length})</summary>
          <ul className="mt-3 space-y-2">
            {aboutMe.map((note) => (
              <li key={note.id} className="flex items-start justify-between gap-3">
                <span>{note.content}</span>
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Forget</button>}
                  title="Forget this?"
                  description="It will stop using it in your conversations."
                  confirmLabel="Forget"
                  destructive
                  onConfirm={deleteAssistantNote.bind(null, note.id)}
                />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
