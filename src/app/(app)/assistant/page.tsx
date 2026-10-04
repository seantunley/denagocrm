import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isCodexConnected } from "@/lib/codex";
import { getSetting } from "@/lib/settings";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { assistantHistory } from "@/lib/crmAssistant";
import { markScheduledTurnsSeen } from "@/lib/assistantScheduleRun";
import { describeSchedule } from "@/lib/assistantSchedule";
import AssistantChat from "@/components/AssistantChat";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { deleteAssistantNote } from "@/app/actions/assistantNotes";
import { deleteAssistantSchedule, setAssistantScheduleActive } from "@/app/actions/assistantSchedules";
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
  const [connected, profile, history, aboutMe, schedules] = await Promise.all([
    isCodexConnected(),
    getSetting(ASSISTANT_PROFILE_KEY).then(parseProfile),
    assistantHistory(user.id),
    prisma.assistantNote.findMany({ where: { kind: "profile", userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true, content: true } }),
    // This person's own schedules only.
    prisma.assistantSchedule.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, question: true, cadence: true, weekday: true, timeOfDay: true, onDate: true, nextRunAt: true, active: true },
    }),
    // Being on this page is seeing them: the bubble's unread dot goes.
    markScheduledTurnsSeen(user.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={profile.name === "Assistant" ? "Ask the CRM" : `Ask ${profile.name}`}
        description="Your sales colleague: it reads your leads, quotes, activities and the business's own knowledge, and tells you what it means — never more than your own lists show you."
      />
      {connected ? (
        <AssistantChat name={profile.name} history={history.map(({ question, answer, source }) => ({ question, answer, source }))} />
      ) : (
        <p className="card p-5 text-sm text-muted-foreground">
          This runs on your workspace&apos;s ChatGPT connection, which isn&apos;t set up yet.{" "}
          <Link href="/settings/integrations" className="text-primary underline">Connect ChatGPT</Link> to start asking.
        </p>
      )}
      <section className="card space-y-3 p-4 text-sm">
        <h2 className="font-medium">⏰ Scheduled</h2>
        {schedules.length === 0 ? (
          <p className="text-muted-foreground">
            Ask {profile.name} to look into something on a schedule — e.g. &ldquo;every Monday at 7, tell me which deals went quiet&rdquo;. You confirm it first; it runs as you, within half an hour of the time.
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {schedules.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{describeSchedule(s)}</p>
                  <p className="text-muted-foreground">{s.question}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.active && s.nextRunAt
                      ? `Next: ${s.nextRunAt.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
                      : "Paused"}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3">
                  <ConfirmActionDialog
                    trigger={<button type="button" className="text-xs text-muted-foreground hover:text-foreground">{s.active ? "Pause" : "Resume"}</button>}
                    title={s.active ? "Pause this?" : "Resume this?"}
                    description={s.active ? "It won't run until you resume it." : "It runs from its next time — missed runs aren't made up."}
                    confirmLabel={s.active ? "Pause" : "Resume"}
                    onConfirm={setAssistantScheduleActive.bind(null, s.id, !s.active)}
                  />
                  <ConfirmActionDialog
                    trigger={<button type="button" className="text-xs text-muted-foreground hover:text-destructive">Delete</button>}
                    title="Delete this scheduled question?"
                    description="It won't run again. Answers it already gave stay in your history."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={deleteAssistantSchedule.bind(null, s.id)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
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
