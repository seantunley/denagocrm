"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setMyProactive } from "@/app/actions/assistantSettings";

/**
 * "Let DAX come to me" — each person's own switch for proactive DAX (lib/proactive.ts). Only offered while an owner
 * has it on for the workspace; says so when they have not, rather than hiding that it exists.
 */
export default function AssistantProactiveCard({ name, workspaceOn, on }: { name: string; workspaceOn: boolean; on: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState("");
  return (
    <section className="card space-y-3 p-5 text-sm" aria-label={`${name} comes to you`}>
      <h2 className="text-base font-semibold">{name} comes to you</h2>
      <label className={`flex items-start gap-2 ${workspaceOn ? "cursor-pointer" : "opacity-60"}`}>
        <input
          type="checkbox"
          name="proactiveMe"
          className="mt-1 accent-primary"
          checked={on}
          disabled={pending || (!workspaceOn && !on)}
          onChange={(e) => {
            const next = e.target.checked;
            setProblem("");
            startTransition(async () => {
              const result = await setMyProactive(next);
              if (result?.error) setProblem(result.error);
              router.refresh();
            });
          }}
        />
        <span>
          <span className="block font-medium">Tell me the moment a customer acts</span>
          <span className="block text-xs text-muted-foreground">
            When one of your customers opens a quote, comes back to it a third time, signs it, books a service, or writes
            and has waited 15 minutes with no answer, {name} tells you — here, as a phone notification, and on your linked
            WhatsApp. Only about customers and deals that are yours. Nothing between 20:00 and 08:00: those wait for the
            morning. At most 12 a day. {name} never contacts the customer.
          </span>
          {!workspaceOn && <span className="mt-1 block text-xs text-amber-400">An owner has not switched this on for the workspace yet (Settings → Assistant).</span>}
        </span>
      </label>
      {problem && <p role="alert" className="text-xs text-red-400">{problem}</p>}
    </section>
  );
}
