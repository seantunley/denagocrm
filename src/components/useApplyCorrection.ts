"use client";

import type { Dispatch, RefObject } from "react";
import { stopAsking } from "@/components/askStream";
import type { ChatItem, ChatQueue, ChatQueueAction } from "@/components/chatQueue";
import { correctedQuestion, looksLikeCorrection } from "@/lib/assistantCorrection";

type Flight = { key: string; stopper: AbortController; item: ChatItem<Blob> } | null;

/**
 * "Apply correction" on a queued message that corrects the question being answered (lib/assistantCorrection).
 *
 * The corrected question goes to the FRONT of the queue first, then the running answer is stopped the way Stop
 * stops it — nothing from a stopped answer is kept, so it is out of the conversation. Too late to stop (it had just
 * finished): the corrected question is simply the next turn. Anything else queued runs once, after it.
 */
export function useApplyCorrection({ chat, dispatch, flight, name, setNotice }: {
  chat: ChatQueue<Blob>;
  dispatch: Dispatch<ChatQueueAction<Blob>>;
  flight: RefObject<Flight>;
  name: string;
  setNotice: (notice: string | null) => void;
}) {
  const offer = (item: ChatItem<Blob>) => Boolean(chat.running && !item.image && looksLikeCorrection(item.text, chat.running.text));

  const apply = async (item: ChatItem<Blob>) => {
    const running = chat.running;
    if (!running) return;
    dispatch({ type: "correct", id: item.id, text: correctedQuestion(running.text, item.text), image: running.image });
    const current = flight.current;
    if (!current || chat.stopping) {
      setNotice("Correction applied — it goes next.");
      return;
    }
    dispatch({ type: "stopping" });
    if (!(await stopAsking(current.key))) {
      dispatch({ type: "stopRefused" });
      setNotice(`${name} had already finished — your corrected question goes next.`);
      return;
    }
    current.stopper.abort();
    setNotice("Stopped — asking again with your correction.");
  };

  return { offer, apply };
}
