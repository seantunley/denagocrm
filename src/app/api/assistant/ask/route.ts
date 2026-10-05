import { NextRequest, NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { askAsPerson } from "@/lib/assistantAsk";
import { logError } from "@/lib/errorLog";
import type { AskStreamEvent } from "@/lib/assistantStream";
import { isSameOrigin } from "@/lib/sameOrigin";

/**
 * Ask DAX and watch the answer arrive — the chat's only way to ask. The checks
 * are askAsPerson's; the answer is streamed as it is written, so the person
 * reads the first words within a few seconds instead of waiting for all of it.
 *
 * Response: newline-delimited JSON. {"t":"text","v":<visible answer so far>}
 * any number of times (never a LEARN/ACTIONS/CHOICES line — assistantStream),
 * then exactly one {"t":"done","r":<AssistantResult>}.
 *
 * WHO: a signed-in person (requireApiUser — the full session checks) with an
 * assistant permission. Unlike a server action this is a plain route, so it
 * also refuses a request from another site: the session cookie is SameSite=Lax
 * (not sent on a cross-site POST) and, as a second guard, the browser's own
 * Sec-Fetch-Site / Origin must say same-origin.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Research rounds + the answer: well inside Vercel's ceiling.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req.headers)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return withActingStaffScope(async () => {
    let user;
    try {
      user = await requireApiUser();
      if (!(await hasAnyPermission(user, ...ASSISTANT_PERMISSIONS))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    } catch (error) {
      return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Unavailable" }, { status: 503 });
    }
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "Bad request" }, { status: 400 });
    const asker = user;

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
        const result = await askAsPerson(
          asker,
          { question: form.get("question"), page: form.get("page"), image: form.get("image") },
          (visible) => send({ t: "text", v: visible }),
        ).catch(async (error: unknown) => {
          await logError("crm-assistant", "streamed ask failed", error instanceof Error ? error.name : "unknown");
          return { ok: false as const, error: "Something went wrong — try again." };
        });
        send({ t: "done", r: result });
        if (open) controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
