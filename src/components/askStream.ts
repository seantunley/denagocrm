"use client";

import type { AssistantResult } from "@/lib/crmAssistant";
import type { AskStreamEvent } from "@/lib/assistantStream";

/**
 * Ask through the streaming route, passing the visible answer to `onText` as it
 * is written. Null when streaming isn't available (old browser, the route
 * refused, the connection dropped before the end) — the caller then asks the
 * ordinary way, so the person still gets their answer.
 */
export async function askStreaming(form: FormData, onText: (visibleSoFar: string) => void): Promise<AssistantResult | null> {
  let res: Response;
  try {
    res = await fetch("/api/assistant/ask", { method: "POST", body: form, credentials: "same-origin" });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
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
    return null;
  }
  return null;
}
