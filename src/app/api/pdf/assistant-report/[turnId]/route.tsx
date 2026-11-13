import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { requireApiUser, apiAuthErrorResponse } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { buildReport, printable, reportFileName } from "@/lib/assistantReport";
import { reportLogoPng } from "@/lib/assistantReportLogo";
import { getCompanyProfile } from "@/lib/companyProfile";
import { brandForTenant } from "@/lib/tenantBrand";
import { ownedWriteTenantId } from "@/lib/tenantWrite";
import { getRegionalSettings, getSetting } from "@/lib/settings";
import { formatDateTime } from "@/lib/format";
import AssistantReportDoc, { type AssistantReportMeta } from "@/lib/pdf/AssistantReportDoc";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One of the assistant's answers, as a PDF report with the business's name and
 * logo in its header (lib/assistantReport.ts says what a report is).
 *
 * WHO MAY HAVE IT: only the person the answer was given to. Conversations with
 * the assistant are private to each person — the workspace owner sees totals,
 * never what was asked — so the answer is looked up by its id AND their user id,
 * and anyone else's id answers exactly as a missing one does.
 *
 * NOTHING IS LOOKED UP AGAIN. The report is the stored answer, laid out: it
 * cannot hold a record the answer did not, and it says in its footer when the
 * figures were true.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ turnId: string }> }) {
  return withActingStaffScope(async () => handleGet((await params).turnId));
}

async function handleGet(turnId: string) {
  // Everything that can fail sits inside the try — react-pdf JSX must not be
  // constructed in a try/catch (react-hooks/error-boundaries).
  let loaded: { report: ReturnType<typeof buildReport>; meta: AssistantReportMeta; fileName: string };
  try {
    const user = await requireApiUser();
    if (!(await hasAnyPermission(user, ...ASSISTANT_PERMISSIONS))) return new Response("Forbidden", { status: 403 });
    if (!(await isModuleEnabled("automation"))) return new Response("Not found", { status: 404 });

    const turn = await prisma.assistantTurn.findFirst({
      where: { id: String(turnId), userId: user.id },
      select: { question: true, answer: true, createdAt: true },
    });
    if (!turn || !turn.answer.trim()) return new Response("Not found", { status: 404 });

    const tenantId = ownedWriteTenantId();
    const [company, brand, profileRaw, regional] = await Promise.all([
      getCompanyProfile(),
      brandForTenant(tenantId),
      getSetting(ASSISTANT_PROFILE_KEY),
      getRegionalSettings(),
    ]);
    const report = buildReport(turn.question, turn.answer);
    loaded = {
      report,
      fileName: reportFileName(report.title, company.name),
      meta: {
        companyName: company.name,
        tagline: company.tagline,
        logo: await reportLogoPng(tenantId, company.logoUrl),
        accent: brand.primary,
        assistantName: parseProfile(profileRaw).name,
        preparedFor: user.name || "a colleague",
        answeredAt: formatDateTime(turn.createdAt, regional),
        generatedAt: formatDateTime(new Date(), regional),
        question: printable(turn.question).slice(0, 600),
      },
    };
  } catch (err) {
    const r = apiAuthErrorResponse(err);
    if (r) return r;
    throw err;
  }

  const buf = Buffer.from(await renderToBuffer(<AssistantReportDoc report={loaded.report} meta={loaded.meta} />));

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${loaded.fileName}"`,
      // A private answer: never stored by a shared cache.
      "Cache-Control": "private, no-store",
    },
  });
}
