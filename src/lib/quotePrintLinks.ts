/**
 * The invoice and sales agreement for a quote, as print links.
 *
 * Offered once the quote is ACCEPTED — before that there is nothing to invoice
 * and no sale to agree. The routes (app/(print)/quotes/[id]/invoice|agreement)
 * gate on requireQuoteReadAccess, i.e. quote view permission + access to this
 * quote (getAccessibleQuoteIds). Every place that renders these links only does
 * so for quotes that already passed that same check.
 */
export function quotePrintLinks(quote: { id: string; status: string }): { label: string; href: string }[] {
  if (quote.status !== "accepted") return [];
  return [
    { label: "Print invoice", href: `/quotes/${quote.id}/invoice` },
    { label: "Print sales agreement", href: `/quotes/${quote.id}/agreement` },
  ];
}
