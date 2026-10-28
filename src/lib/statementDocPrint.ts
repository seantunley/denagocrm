import "server-only";
import { publishedBuilderTemplateFor } from "@/lib/docbuilder/published";
import { statementLayoutFromPublishedInvoice } from "@/lib/docbuilder/store";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import type { DocumentModel } from "@/lib/doceditor/model";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import { bindCtx, logoDataUri } from "@/lib/signing/render";
import { getRegionalSettings } from "@/lib/settings";
import { formatZAR } from "@/lib/format";
import { loadContactStatement, loadFleetStatement } from "@/lib/accountStatementLoader";
import { billedElsewhereNote, statementDocTokens, statementRows, statementWarningsHtml } from "@/lib/statementDoc";
import type { PermissionUser } from "@/lib/permissions";

/**
 * THE CUSTOMER STATEMENT, PRINTED FROM THE DOCUMENT EDITOR — the same engine,
 * look and banking details as the invoice (Sean, 2026-10-28).
 *
 * Which layout, in order:
 *   1. the Statement layout, once someone has PUBLISHED it (Document Studio);
 *   2. otherwise the workspace's PUBLISHED invoice, converted on the spot
 *      (doceditor/statementLayout.ts) — approved content, and always the
 *      invoice as it is today, banking details included;
 *   3. otherwise nothing, and the caller prints the old fixed page.
 *
 * The figures come from the same loader as before (accountStatementLoader.ts):
 * the workspace named on every query, a partial statement refused, trashed
 * quotes' figures withheld from those who cannot read them.
 */

export async function statementPrintLayout(): Promise<DocumentModel | null> {
  const own = await publishedBuilderTemplateFor("statement");
  if (own) {
    const read = readTemplateDocument(own.data, own.name);
    if (read.status === "ok") return read.doc;
  }
  return statementLayoutFromPublishedInvoice();
}

export type StatementDocResult =
  | { kind: "ok"; html: string }
  | { kind: "partial" }
  | { kind: "missing" }
  /** No published statement or invoice layout: print the old page. */
  | { kind: "no-layout" };

export async function renderStatementDocHtml(opts: {
  account: "contact" | "fleet";
  id: string;
  user: PermissionUser;
  toolbarHtml?: string;
}): Promise<StatementDocResult> {
  const layout = await statementPrintLayout();
  if (!layout) return { kind: "no-layout" };

  const regional = await getRegionalSettings();
  const fmt = (cents: number) => formatZAR(cents, regional);
  const loaded = opts.account === "contact"
    ? await loadContactStatement(opts.user, opts.id, fmt)
    : await loadFleetStatement(opts.user, opts.id, fmt);
  if (loaded.kind !== "ok") return loaded;

  // The workspace's company details, logo and regional settings — no record.
  const base = await bindCtx(null, null);
  const { tokens, vars } = statementDocTokens(loaded.statement, loaded.billTo, new Date(), regional);
  const ctx = {
    ...base,
    tokens: { ...(base?.tokens ?? {}), ...tokens },
    vars,
    items: [],
    statementRows: statementRows(loaded.statement, regional),
    regional,
    bound: true,
  };
  const staffOnly = statementWarningsHtml(loaded.statement.warnings, billedElsewhereNote(loaded.billedElsewhere));
  const html = renderDocumentHtml(layout, ctx, logoDataUri(), {
    hideOverlays: true,
    toolbarHtml: `${opts.toolbarHtml ?? ""}${staffOnly}`,
  });
  return { kind: "ok", html };
}
