import { NextRequest, NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { askAsPerson } from "@/lib/assistantAsk";
import { logError } from "@/lib/errorLog";
import type { AskStreamEvent } from "@/lib/assistantStream";
import { isSameOrigin } from "@/lib/sameOrigin";
import { RUN_KEY, claimRun, readRun, runRecorder } from "@/lib/assistantRun";
import type { AssistantResult } from "@/lib/crmAssistant";

/**
 * Ask DAX and watch the answer arrive — the chat's only way to ask. The checks
 * are askAsPerson's; the answer is streamed as it is written, so the person
 * reads the first words within a few seconds instead of waiting for all of it.
 *
 * Response: newline-delimited JSON. {"t":"status","v":"Checking leads…"} while
 * it researches, then {"t":"text","v":<visible answer so far>} any number of
 * times (never a LEARN/ACTIONS/CHOICES line — assistantStream), then exactly
 * one {"t":"done","r":<AssistantResult>}.
 *
 * RUNS (assistantRun): the chat names each question with a `runKey` before it
 * sends it. POST with a new key runs it — exactly once, by a unique index — and
 * records its progress as it goes. POST with a key that already exists (a
 * retry after a dropped connection) does NOT run it again: it streams that
 * run's progress from the record, as GET ?run=<key> does for a reconnect. So a
 * dropped connection costs a moment, never a second answer.
 *
 * WHO: a signed-in person (requireApiUser — the full session checks) with an
 * assistant permission. Unlike a server action this is a plain route, so it
 * also refuses a request from another site: the session cookie is SameSite=Lax
 * (not sent on a cross-site POST) and, as a second guard, the browser's own
 * Sec-Fetch-Site / Origin must say same-origin. A run is only ever read by the
 * person who asked it (readRun names userId).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Research rounds + the answer: well inside Vercel's ceiling.
export const maxDuration = 300;

/** How often a follower re-reads the run, and how long it follows before giving up. */
const FOLLOW_EVERY_MS = 600;
const FOLLOW_FOR_MS = 280_000;

const NDJSON = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

async function signedInAsker() {
  try {
    const user = await requireApiUser();
    if (!(await hasAnyPermission(user, ...ASSISTANT_PERMISSIONS))) return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    return { user };
  } catch (error) {
    return { refused: apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Unavailable" }, { status: 503 }) };
  }
}

/** A stream whose body is written by `run`; a closed connection never stops the work. */
function ndjson(run: (send: (event: AskStreamEvent) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: AskStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false; // the person closed the chat — the answer still finishes and is saved
        }
      };
      await run(send);
      if (open) controller.close();
    },
  });
  return new Response(stream, { headers: NDJSON });
}

/** Stream an existing run from its record until it finishes (or we stop following). */
async function follow(userId: string, key: string, send: (event: AskStreamEvent) => void) {
  const until = Date.now() + FOLLOW_FOR_MS;
  let status = "";
  let partial = "";
  while (Date.now() < until) {
    const run = await readRun(userId, key).catch(() => null);
    if (!run) {
      send({ t: "done", r: { ok: false, error: "That question isn't there any more — ask again." } satisfies AssistantResult });
      return;
    }
    if (run.statusText && run.statusText !== status) send({ t: "status", v: (status = run.statusText) });
    if (run.partial && run.partial !== partial) send({ t: "text", v: (partial = run.partial) });
    if (run.result) {
      send({ t: "done", r: run.result });
      return;
    }
    await new Promise((r) => setTimeout(r, FOLLOW_EVERY_MS));
  }
  send({ t: "done", r: { ok: false, error: "Still working on it — open the Ask page in a minute to see the answer." } satisfies AssistantResult });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return withActingStaffScope(async () => {
    const asker = await signedInAsker();
    if ("refused" in asker) return asker.refused;
    const user = asker.user;
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const rawKey = form.get("runKey");
    const key = typeof rawKey === "string" && RUN_KEY.test(rawKey) ? rawKey : null;

    // Already asked under this key (a retry): read it, never run it twice.
    const claimed = key ? await claimRun(user.id, key).catch(async (error: unknown) => {
      await logError("assistant-run", "couldn't record the run", error instanceof Error ? error.name : "unknown");
      return null;
    }) : null;
    if (key && claimed && !claimed.created) return ndjson((send) => follow(user.id, key, send));

    const recorder = claimed ? runRecorder(claimed.id, user.id) : null;
    return ndjson(async (send) => {
      const timings: Record<string, number> = {};
      const result = await askAsPerson(
        user,
        { question: form.get("question"), page: form.get("page"), image: form.get("image") },
        {
          onAnswerText: (visible) => {
            send({ t: "text", v: visible });
            recorder?.partial(visible);
          },
          onProgress: (status) => {
            send({ t: "status", v: status });
            recorder?.phase("researching", status);
          },
          onPhase: (phase) => recorder?.phase(phase),
          timings,
        },
      ).catch(async (error: unknown): Promise<AssistantResult> => {
        await logError("crm-assistant", "streamed ask failed", error instanceof Error ? error.name : "unknown");
        return { ok: false, error: "Something went wrong — try again." };
      });
      await recorder?.finish(result, timings);
      send({ t: "done", r: result });
    });
  });
}

/** Reconnect: stream the person's own run named by ?run=<key>. Never runs anything. */
export async function GET(req: NextRequest) {
  if (!isSameOrigin(req.headers)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return withActingStaffScope(async () => {
    const asker = await signedInAsker();
    if ("refused" in asker) return asker.refused;
    const key = req.nextUrl.searchParams.get("run") ?? "";
    if (!RUN_KEY.test(key)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const userId = asker.user.id;
    return ndjson((send) => follow(userId, key, send));
  });
}
