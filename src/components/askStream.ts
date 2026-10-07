"use client";

import type { AssistantResult } from "@/lib/crmAssistant";
import type { AskStreamEvent } from "@/lib/assistantStream";

/** Only after every reconnect has failed: the run may still finish and be saved. */
export const STREAM_DROPPED =
  "The connection dropped — your answer may still be saved. Check the Ask page before asking again.";

/** Pauses between reconnect attempts after a drop. */
export const RECONNECT_DELAYS_MS = [800, 2000, 4000, 8000];

/**
 * Ask through the streaming route, passing the visible answer to `onText` as it
 * is written.
 *
 * ASKED EXACTLY ONCE, NOW WITH A WAY BACK. The question is named (runKey)
 * before it is sent, and only ever POSTed once. If the connection drops — even
 * before the first word, while the server is still researching — the browser
 * reconnects with GET ?run=<key>, which only READS that run on the server: its
 * status, the answer so far, and the finished result with its cards. The
 * server never runs a key twice either (assistantRun), so no path gives one
 * click a second answer, second learning or second proposed tasks.
 */
export async function askStreaming(
  form: FormData,
  onText: (visibleSoFar: string) => void,
  onStatus: (status: string) => void = () => {},
  opts: { pause?: (ms: number) => Promise<void>; key?: string } = {},
): Promise<AssistantResult> {
  const key = opts.key ?? newRunKey();
  form.set("runKey", key);
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const first = await readStream(() => fetch("/api/assistant/ask", { method: "POST", body: form, credentials: "same-origin" }), onText, onStatus);
  if (first.kind === "done") return first.result;
  // 4xx: refused before anything ran (signed out, no permission, bad form).
  if (first.kind === "refused") return { ok: false, error: "Something went wrong — try again." };

  // Dropped, or a gateway cut it off: the run may be going on without us. Follow it.
  for (const ms of RECONNECT_DELAYS_MS) {
    await pause(ms);
    onStatus("Reconnecting…");
    const again = await readStream(() => fetch(`/api/assistant/ask?run=${encodeURIComponent(key)}`, { credentials: "same-origin" }), onText, onStatus);
    if (again.kind === "done") return again.result;
    if (again.kind === "refused") break;
  }
  return { ok: false, error: STREAM_DROPPED };
}

type Outcome = { kind: "done"; result: AssistantResult } | { kind: "dropped" } | { kind: "refused" };

async function readStream(
  request: () => Promise<Response>,
  onText: (visibleSoFar: string) => void,
  onStatus: (status: string) => void,
): Promise<Outcome> {
  let res: Response;
  try {
    res = await request();
  } catch {
    return { kind: "dropped" };
  }
  if (!res.ok || !res.body) return res.status < 500 ? { kind: "refused" } : { kind: "dropped" };
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
        if (event.t === "status") onStatus(event.v);
        else if (event.t === "text") onText(event.v);
        else if (event.t === "done") return { kind: "done", result: event.r as AssistantResult };
      }
    }
  } catch {
    // fall through: dropped mid-stream
  }
  return { kind: "dropped" };
}

/** A fresh name for one question — random, so nobody can guess another person's (and reads check the asker anyway). */
function newRunKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
