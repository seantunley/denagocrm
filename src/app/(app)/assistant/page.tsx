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
import { deleteAssistantNote, saveMyAssistantNote } from "@/app/actions/assistantNotes";
import { SaveForm, SaveButton } from "@/components/SaveForm";
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
      <details className="card p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          About you — what {profile.name} knows{aboutMe.length ? ` (${aboutMe.length})` : ""}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">
          Used only in your own conversations. {profile.name} adds to this as it learns how you work; you can add, correct or remove anything.
        </p>
        <ul className="mt-3 divide-y divide-border/50">
          {aboutMe.map((note) => (
            <li key={note.id} className="space-y-2 py-2">
              <p className="whitespace-pre-line">{note.content}</p>
              <div className="flex flex-wrap items-center gap-2">
                <details className="w-full text-xs sm:w-auto">
                  <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground">Edit</summary>
                  <SaveForm action={saveMyAssistantNote.bind(null, note.id)} resetOnSuccess={false} className="mt-2 space-y-2">
                    <textarea name="content" defaultValue={note.content} rows={2} maxLength={400} className="input w-full" />
                    <SaveButton className="btn-primary btn-sm">Save</SaveButton>
                  </SaveForm>
                </details>
                <ConfirmActionDialog
                  trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Forget</button>}
                  title="Forget this?"
                  description="It will stop using it in your conversations."
                  confirmLabel="Forget"
                  destructive
                  onConfirm={deleteAssistantNote.bind(null, note.id)}
                />
              </div>
            </li>
          ))}
        </ul>
        <SaveForm action={saveMyAssistantNote.bind(null, null)} className="mt-3 space-y-2">
          <textarea
            name="content"
            rows={2}
            maxLength={400}
            className="input w-full"
            placeholder="e.g. I look after fleet and golf-estate deals in Gauteng. Short answers with bullet points, please."
          />
          <SaveButton className="btn-secondary btn-sm">Tell {profile.name}</SaveButton>
        </SaveForm>
      </details>
    </div>
  );
}
