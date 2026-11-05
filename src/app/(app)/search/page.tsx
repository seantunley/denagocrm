import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { searchCrm } from "@/lib/crmSearch";
import { ALL_SEARCH_GROUPS } from "@/lib/recordSearch";

/**
 * Search everything this person may open: records, messages and notes, cases, activities, documents, products and the
 * chatbot's approved answers — the one search (lib/crmSearch.ts) the search menu and DAX use too.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  if (!term) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-semibold tracking-[-0.035em]">Search</h1>
        <p className="text-sm text-muted-foreground">
          Search the customers, deals, quotes, vehicles, job cards, messages and notes, cases, activities, documents and
          approved answers you are permitted to open. Words are matched, not meaning: try other words if nothing turns up.
        </p>
      </div>
    );
  }

  const hits = await searchCrm(user, term);
  const groups = ALL_SEARCH_GROUPS.map((group) => ({ ...group, rows: hits.filter((hit) => hit.type === group.type) })).filter((group) => group.rows.length);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-[-0.035em]">
        Results for “{term}” <span className="text-base font-normal text-muted-foreground">({hits.length})</span>
      </h1>
      {hits.length === 0 && (
        <div className="card py-10 text-center">
          <p className="text-muted-foreground">Nothing you can open matched that search. Words are matched, not meaning — try other words.</p>
        </div>
      )}
      {groups.map((group) => (
        <div key={group.type} className="card">
          <h2 className="mb-3 font-semibold">
            {group.heading} <span className="font-normal text-muted-foreground">({group.rows.length})</span>
          </h2>
          <ul className="divide-y divide-border">
            {group.rows.map((hit) => (
              <li key={`${hit.type}-${hit.id}`} className="py-2">
                {hit.newTab ? (
                  <a href={hit.href} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">{hit.label}</a>
                ) : (
                  <Link href={hit.href} className="font-medium text-primary hover:underline">{hit.label}</Link>
                )}
                {hit.sublabel && <span className="ml-2 text-xs text-muted-foreground">{hit.sublabel}</span>}
                {hit.snippet && <p className="mt-0.5 text-xs text-muted-foreground">{hit.snippet}</p>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
