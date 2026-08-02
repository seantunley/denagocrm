import { redirect } from "next/navigation";

/**
 * The full quote record has been retired — the editor does everything it did.
 *
 * Kept as a redirect rather than deleted, because the id in this URL is spread
 * across the product and beyond it: the leads page, the deliveries board, stock
 * units, test drives, global search, two dashboard widgets, the documents panel
 * and the print pages' "Back to quote". Those could all have been repointed.
 * The ones that could not are the reason this file still exists — bookmarks,
 * and push notifications already delivered to someone's phone.
 *
 * No access check: a redirect grants nothing, and the id is one the caller
 * already had. /quotes enforces its own, and the editor refuses to open a quote
 * the caller may not read — landing them where a guard here would have, with a
 * reason rather than a silent bounce.
 */
export default async function QuoteRecordRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/quotes?edit=${id}`);
}
