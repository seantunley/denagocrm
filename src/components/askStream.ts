"use client";

import type { AssistantResult } from "@/lib/crmAssistant";
import type { AskStreamEvent } from "@/lib/assistantStream";

/** Once the request may have reached the server, it may still be answering — and saving. */
export const STREAM_DROPPED =
  "The connection dropped — your answer may still be saved. Check the Ask page before asking again.";

/**
 * Ask through the streaming route, passing the visible answer to `onText` as it
 * is written.
 *
 * ASKED EXACTLY ONCE. A connection that fails at any point — even before the
 * first word, while the server is still researching — may have reached the
 * server, which carries on, answers and saves. So a failure here is reported,
 * never retried another way: a second ask would mean a second answer, second
 * learning and second proposed actions from one click.
 */
export async function askStreaming(form: FormData, onText: (visibleSoFar: string) => void): Promise<AssistantResult> {
  let res: Response;
  try {
    res = await fetch("/api/assistant/ask", { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    return { ok: false, error: STREAM_DROPPED };
  }
  // 4xx: refused before anything ran (signed out, no permission, bad form).
  // 5xx: a gateway may have cut off a request that did run — not safe to retry.
  if (!res.ok || !res.body) return { ok: false, error: res.status < 500 ? "Something went wrong — try again." : STREAM_DROPPED };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as AskStreamEvent;
        if (event.t === "text") onText(event.v);
        else if (event.t === "done") return event.r as AssistantResult;
      }
    }
  } catch {
    // fall through: dropped mid-stream
  }
  return { ok: false, error: STREAM_DROPPED };
}
