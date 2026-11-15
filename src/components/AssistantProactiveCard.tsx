"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMyBriefTime, setMyChatbotProblems, setMyMondayStuck, setMyOpeningLine, setMyProactive } from "@/app/actions/assistantSettings";
import { BRIEF_TIMES } from "@/lib/proactiveRules";

/**
 * "Let DAX come to me" — each person's own switch for proactive DAX (lib/proactive.ts), and their morning-brief time
 * (lib/proactiveBrief.ts). Only offered while an owner has it on for the workspace; says so when they have not,
 * rather than hiding that it exists.
 */
export default function AssistantProactiveCard({ name, workspaceOn, on, briefAt, mondayStuck, chatbotProblems, openingOn }: {
  name: string; workspaceOn: boolean; on: boolean; briefAt: string; mondayStuck: boolean;
  /** The owner's "chatbot problems" switch; null for anyone else (only the owner can open the System Log). */
  chatbotProblems: boolean | null;
  /** DAX speaks first: their own switch, offered whatever the workspace's proactive switch says (in-app, no AI). */
  openingOn: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState("");
  const run = (work: () => Promise<{ error?: string } | undefined>) => {
    setProblem("");
    startTransition(async () => {
      const result = await work();
      if (result?.error) setProblem(result.error);
      router.refresh();
    });
  };
  return (
    <section className="card space-y-3 p-5 text-sm" aria-label={`${name} comes to you`}>
      <h2 className="text-base font-semibold">{name} comes to you</h2>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          name="openingLine"
          className="mt-1 accent-primary"
          checked={openingOn}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            run(() => setMyOpeningLine(next));
          }}
        />
        <span>
          <span className="block font-medium">Say what&apos;s new when I open a chat</span>
          <span className="block text-xs text-muted-foreground">
            When you start a new conversation, {name} opens with the top two things from your daily brief — the same list as
            your home page — e.g. a customer waiting for a reply or a quote about to expire, each linked. Only what your
            own lists show. Nothing to say, it says nothing. No AI is used and no one is contacted.
          </span>
        </span>
      </label>
      <label className={`flex items-start gap-2 ${workspaceOn ? "cursor-pointer" : "opacity-60"}`}>
        <input
          type="checkbox"
          name="proactiveMe"
          className="mt-1 accent-primary"
          checked={on}
          disabled={pending || (!workspaceOn && !on)}
          onChange={(e) => {
            const next = e.target.checked;
            run(() => setMyProactive(next));
          }}
        />
        <span>
          <span className="block font-medium">Tell me the moment a customer acts</span>
          <span className="block text-xs text-muted-foreground">
            When one of your customers opens a quote, comes back to it a third time, signs it, books a service, or writes
            and has waited 15 minutes with no answer, {name} tells you — here, as a phone notification, and on your linked
            WhatsApp. The day before one of your deliveries, it checks the deposit, invoice, cart and PDI and tells you
            what is missing. Only about customers and deals that are yours. Nothing between 20:00 and 08:00: those wait for the
            morning. At most 12 a day. {name} never contacts the customer.
          </span>
          {!workspaceOn && <span className="mt-1 block text-xs text-amber-400">An owner has not switched this on for the workspace yet (Settings → Assistant).</span>}
        </span>
      </label>
      {on && (
        <label className="block pl-6 text-xs text-muted-foreground">
          <span className="block font-medium text-foreground">Morning brief</span>
          <select
            name="briefAt"
            className="input mt-1 w-full max-w-xs"
            value={briefAt}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value;
              run(() => setMyBriefTime(next));
            }}
          >
            {BRIEF_TIMES.map((time) => <option key={time} value={time}>Weekdays at {time}</option>)}
            <option value="off">Off</option>
          </select>
          <span className="mt-1 block">
            {name} writes your day: what is on, what your customers did since yesterday — anything held overnight is in it —
            and the three things that matter most. Uses one AI answer each morning.
          </span>
        </label>
      )}
      {on && briefAt !== "off" && (
        <label className="flex cursor-pointer items-start gap-2 pl-6 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name="mondayStuck"
            className="mt-0.5 accent-primary"
            checked={mondayStuck}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              run(() => setMyMondayStuck(next));
            }}
          />
          <span>
            <span className="block font-medium text-foreground">Stuck deals on Mondays</span>
            On Mondays the brief adds your three most-stuck deals, each with its main reason and a link — and, if you
            manage a team, the team&apos;s. It changes nothing and contacts no one.
          </span>
        </label>
      )}
      {on && briefAt !== "off" && chatbotProblems !== null && (
        <label className="flex cursor-pointer items-start gap-2 pl-6 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name="chatbotProblems"
            className="mt-0.5 accent-primary"
            checked={chatbotProblems}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              run(() => setMyChatbotProblems(next));
            }}
          />
          <span>
            <span className="block font-medium text-foreground">Chatbot problems</span>
            When chatbot steps failed in the last 24 hours — a booking, a CRM update, an alert — the brief says how many
            and the commonest reasons, and points you to Settings → System Log. Nothing failed, nothing is said.
          </span>
        </label>
      )}
      {problem && <p role="alert" className="text-xs text-red-400">{problem}</p>}
    </section>
  );
}
