import { requireApiUser, apiAuthErrorResponse } from "@/lib/auth";
import { findReportTurn } from "@/lib/assistantReportTurn";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { wantsReport } from "@/lib/assistantReport";
import { renderAssistantReportPdf } from "@/lib/assistantReportPdf";
import { ownedWriteTenantId } from "@/lib/tenantWrite";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One of the assistant's answers, as a PDF report with the business's name and
 * logo in its header (lib/assistantReport.ts says what a report is).
 *
 * ONLY WHEN ASKED FOR: the question must have asked for a report or a PDF
 * (wantsReport). Every other answer has no button and no PDF.
 *
 * WHO MAY HAVE IT: only the person the answer was given to. Conversations with
 * the assistant are private to each person — the workspace owner sees totals,
 * never what was asked — so the answer is looked up by its id, their user id AND
 * the workspace they are acting in (lib/assistantReportTurn), and anyone else's
 * id, or another workspace's, answers exactly as a missing one does.
 *
 * NOTHING IS LOOKED UP AGAIN. The report is the stored answer, laid out: it
 * cannot hold a record the answer did not, and it says in its footer when the
 * figures were true.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ turnId: string }> }) {
  return withActingStaffScope(async () => handleGet((await params).turnId));
}

async function handleGet(turnId: string) {
  let loaded: Parameters<typeof renderAssistantReportPdf>[0];
  try {
    const user = await requireApiUser();
    if (!(await hasAnyPermission(user, ...ASSISTANT_PERMISSIONS))) return new Response("Forbidden", { status: 403 });
    if (!(await isModuleEnabled("automation"))) return new Response("Not found", { status: 404 });

    // The workspace being acted in, resolved FIRST and named in the lookup (review of #1093): an answer from another
    // workspace is "not found" here, never printed under this one's name and logo.
    const tenantId = ownedWriteTenantId();
    const turn = await findReportTurn(tenantId, user.id, String(turnId));
    if (!turn || !turn.answer.trim()) return new Response("Not found", { status: 404 });
    // Only an answer to a question that asked for a report or a PDF is ever made into one.
    if (!wantsReport(turn.question)) return new Response("Not found", { status: 404 });

    loaded = { tenantId, preparedFor: user.name || "", question: turn.question, answer: turn.answer, answeredAt: turn.createdAt };
  } catch (err) {
    const r = apiAuthErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const { pdf, fileName } = await renderAssistantReportPdf(loaded);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
      // A private answer: never stored by a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
