import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "@/lib/assistantSoul";
import { buildReport, printable, reportFileName } from "@/lib/assistantReport";
import { reportLogoPng } from "@/lib/assistantReportLogo";
import { getCompanyProfile } from "@/lib/companyProfile";
import { brandForTenant } from "@/lib/tenantBrand";
import { REGIONAL_KEYS, getWorkspaceSetting } from "@/lib/settings";
import { formatDateTime, regionalFrom, type Regional } from "@/lib/format";
import AssistantReportDoc from "@/lib/pdf/AssistantReportDoc";

/**
 * One DAX answer as the report PDF — for the Ask page's PDF button (api/pdf/assistant-report) and for WhatsApp,
 * which sends it straight after the answer. Every setting is read for the NAMED workspace, never the ambient one.
 * Nothing is looked up again: the PDF is the answer, laid out.
 */
export async function renderAssistantReportPdf(input: {
  tenantId: string;
  preparedFor: string;
  question: string;
  answer: string;
  answeredAt: Date;
}): Promise<{ pdf: Buffer; fileName: string; title: string }> {
  const { tenantId } = input;
  const fields = Object.keys(REGIONAL_KEYS) as (keyof Regional)[];
  const [company, brand, profileRaw, values] = await Promise.all([
    getCompanyProfile(tenantId),
    brandForTenant(tenantId),
    getWorkspaceSetting(tenantId, ASSISTANT_PROFILE_KEY),
    Promise.all(fields.map((field) => getWorkspaceSetting(tenantId, REGIONAL_KEYS[field]))),
  ]);
  const regional = regionalFrom(Object.fromEntries(fields.map((field, i) => [field, values[i]])));
  const report = buildReport(input.question, input.answer);
  const meta = {
    companyName: company.name,
    tagline: company.tagline,
    logo: await reportLogoPng(tenantId, company.logoUrl),
    accent: brand.primary,
    assistantName: parseProfile(profileRaw).name,
    preparedFor: input.preparedFor || "a colleague",
    answeredAt: formatDateTime(input.answeredAt, regional),
    generatedAt: formatDateTime(new Date(), regional),
    question: printable(input.question).slice(0, 600),
  };
  const pdf = Buffer.from(await renderToBuffer(<AssistantReportDoc report={report} meta={meta} />));
  return { pdf, fileName: reportFileName(report.title, company.name), title: report.title };
}
