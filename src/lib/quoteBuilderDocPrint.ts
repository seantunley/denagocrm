import "server-only";
import { publishedBuilderTemplateFor } from "@/lib/docbuilder/published";
import { legacyDocTextTokens } from "@/lib/docbuilder/quoteDocs";
import { readTemplateDocument } from "@/lib/doceditor/legacy";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
import { getDocTemplate } from "@/lib/docTemplateStore";
import { actingLayoutScope } from "@/lib/docbuilder/store";
import { getCompanyProfile } from "@/lib/companyProfile";
import { bindCtx, logoDataUri } from "@/lib/signing/render";

export type QuoteBuilderDocKey = "invoice" | "agreement";
export const isQuoteBuilderDocKey = (key: string): key is QuoteBuilderDocKey =>
  key === "invoice" || key === "agreement";

/**
 * The invoice / sales agreement printed from the single document editor, the way
 * renderQuotePrintHtml prints the quote. Null until the type's default builder
 * template has been PUBLISHED — the print pages keep their old fixed layout until
 * then — or when the quote does not resolve.
 *
 * The layout and the old template's text are the ACTING workspace's own
 * (docbuilder/layoutScope.ts), named in the query: this prints a bank account
 * to pay into, so another workspace's — or one with no workspace, once there is
 * more than one — is never a candidate, with tenant enforcement off as well as
 * on. Only staff routes print it, so the acting workspace is the one to ask.
 */
export async function renderQuoteBuilderDocHtml(opts: {
  quoteId: string;
  key: QuoteBuilderDocKey;
  toolbarHtml?: string;
}): Promise<string | null> {
  const scope = await actingLayoutScope();
  const template = await publishedBuilderTemplateFor(opts.key, scope);
  if (!template) return null;
  const read = readTemplateDocument(template.data, template.name);
  if (read.status !== "ok") return null;

  const [ctx, legacy, company] = await Promise.all([
    bindCtx(opts.quoteId, null),
    // Banking details, payment terms and clauses are still written on the old
    // document template, and the old page prints them from there — so does this.
    getDocTemplate(opts.key, undefined, scope),
    getCompanyProfile(),
  ]);
  if (!ctx?.bound) return null;
  const text = legacyDocTextTokens(opts.key, legacy);

  return renderDocumentHtml(
    read.doc,
    { ...ctx, tokens: { ...ctx.tokens, ...text.tokens }, vars: { ...ctx.vars, ...text.vars } },
    // The same logo precedence the old page uses. The banner splices this into
    // src="…" unescaped, so anything that could close the attribute is dropped.
    [legacy.logoUrl, company.logoUrl].find((url) => url && !/["'<>\s]/.test(url)) || logoDataUri(),
    // Unsigned paper: no dashed signing boxes.
    { hideOverlays: true, toolbarHtml: opts.toolbarHtml },
  );
}
