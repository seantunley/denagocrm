"use client";

import { useState } from "react";
import AssistantActionCard from "@/components/AssistantActionCard";
import type { ActionCard } from "@/lib/assistantActions";

/**
 * "From WhatsApp — waiting for you to confirm": the tasks this person asked the
 * assistant for on their phone that are only done in the CRM.
 *
 * THE LIST IS HELD, not re-read, and this is always rendered (it shows nothing
 * when there is nothing). Confirming a card runs a real CRM action, and those
 * refresh the page — which re-reads the list, now without the card that was
 * just confirmed. Rendered from that fresh list, the card (and with the last
 * one, the whole section) would vanish before the person had seen "Done" or
 * been given its link. So the list is the one this visit started with: each
 * card shows its own outcome, and a finished one is gone on the next visit.
 *
 * Held cards are never dropped by a refresh, but NEW ones are taken in: a task
 * saved from the phone while this page is open appears on the next refresh
 * instead of waiting for the page to be left and reopened.
 */
export default function SavedAssistantCards({ name, cards }: { name: string; cards: { id: string; card: ActionCard }[] }) {
  const [held, setHeld] = useState(cards);
  const arrived = cards.filter((card) => !held.some((kept) => kept.id === card.id));
  // Adjusting state while rendering (React's pattern for state derived from props): no effect, no extra paint.
  if (arrived.length > 0) setHeld([...held, ...arrived]);
  if (held.length === 0) return null;
  const one = held.length === 1;
  return (
    <section className="card space-y-3 p-4 text-sm">
      <h2 className="font-medium">From WhatsApp — waiting for you to confirm</h2>
      <p className="text-muted-foreground">
        You asked {name} for {one ? "this" : "these"} on WhatsApp. {one ? "It is" : "They are"} only done here, so {one ? "it was" : "they were"} kept
        for you. Nothing happens until you press Confirm or Send; dismiss anything you no longer want. Kept for a day.
      </p>
      <div className="space-y-3">
        {held.map((saved) => (
          <AssistantActionCard key={saved.id} card={saved.card} savedId={saved.id} />
        ))}
      </div>
    </section>
  );
}
