import { notFound, redirect } from "next/navigation";
import StatementDocument from "@/components/print/StatementDocument";
import StatementUnavailable from "@/components/print/StatementUnavailable";
import { loadFleetStatement, statementBillToLines } from "@/lib/accountStatementLoader";
import { getCompanyProfile } from "@/lib/companyProfile";
import { actingLayoutScope } from "@/lib/docbuilder/store";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { formatZAR } from "@/lib/format";
import { requireAnyPermission, requireRoute } from "@/lib/permissions";
import { getRegionalSettings } from "@/lib/settings";
import { getCurrencyOptions } from "@/lib/currency";
import { withCurrency } from "@/lib/currencyRules";
import { statementPrintLayout } from "@/lib/statementDocPrint";

export const dynamic = "force-dynamic";

/** A fleet / business account's statement: every invoice billed to the account, less deposits and payments. */
export default async function FleetStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ legacy?: string; currency?: string }>;
}) {
  const { id } = await params;
  // The fleet screens' own guard (routeAccess.ts), then invoices at all.
  const user = await requireRoute("/fleets");
  await requireAnyPermission("quotes.view_all", "quotes.view_owned");
  // Printed from the document editor when there is a layout (see the contact page).
  const { legacy, currency: asked } = await searchParams;
  if (!legacy && (await statementPrintLayout())) redirect(`/fleets/${id}/statement/document${asked ? `?currency=${encodeURIComponent(asked)}` : ""}`);
  // One statement per currency (multicurrency module): the requested one when this workspace offers it.
  const options = await getCurrencyOptions();
  const currency = asked && options.enabled.includes(asked) ? asked : options.base;
  const regional = withCurrency(await getRegionalSettings(), currency);
  const loaded = await loadFleetStatement(user, id, (cents) => formatZAR(cents, regional), currency);
  if (loaded.kind === "missing") notFound();
  const backHref = `/fleets/${id}`;
  if (loaded.kind === "partial") return <StatementUnavailable backHref={backHref} backLabel="Back to fleet" />;

  // The invoice template's bank details are this workspace's own, like the
  // figures above (docbuilder/layoutScope.ts).
  const scope = await actingLayoutScope();
  const [company, template] = await Promise.all([getCompanyProfile(), getDocTemplate("invoice", undefined, scope)]);
  return (
    <StatementDocument
      company={company}
      template={template}
      regional={regional}
      statement={loaded.statement}
      accountName={loaded.accountName}
      billToLines={statementBillToLines(loaded.billTo)}
      statementDate={new Date()}
      backHref={backHref}
      backLabel="Back to fleet"
    />
  );
}
