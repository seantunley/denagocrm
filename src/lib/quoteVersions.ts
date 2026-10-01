import { recoverableActiveTenantPredicate } from "./tenantPredicate";

/**
 * Quote version history, loaded per family. Not "server-only" (unlike
 * quoteEditorRecord.ts) so it can be unit-tested with a fake client.
 */

/** The slim version rows the family/successor lookups need. */
export type QuoteVersionRow = {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  supersededAt: Date | null;
  revisionOfId: string | null;
  deletedAt: Date | null;
};

export const QUOTE_VERSION_SELECT = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  supersededAt: true,
  revisionOfId: true,
  deletedAt: true,
} as const;

/**
 * Version lookups precomputed once for a batch of quotes. The list builds
 * a page of records from one index; doing it per quote would be quadratic.
 */
export type QuoteVersionIndex = {
  rootFor: (id: string) => string;
  familyOf: (id: string) => QuoteVersionRow[];
  successorOf: (id: string) => QuoteVersionRow | null;
};

export function quoteVersionIndex(allVersions: QuoteVersionRow[]): QuoteVersionIndex {
  const versionById = new Map(allVersions.map((version) => [version.id, version]));
  const rootFor = (id: string) => {
    let current = versionById.get(id);
    const seen = new Set<string>();
    while (current?.revisionOfId && !seen.has(current.id)) {
      seen.add(current.id);
      current = versionById.get(current.revisionOfId) ?? current;
      if (!current.revisionOfId) break;
    }
    return current?.id ?? id;
  };
  const versionsByRoot = new Map<string, QuoteVersionRow[]>();
  for (const version of allVersions) {
    const root = rootFor(version.id);
    versionsByRoot.set(root, [...(versionsByRoot.get(root) ?? []), version]);
  }
  return {
    rootFor,
    familyOf: (id) => versionsByRoot.get(rootFor(id)) ?? [],
    successorOf: (id) => allVersions.find((version) => version.revisionOfId === id && !version.deletedAt) ?? null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Structural, as in quoteBillTo.ts: the generated delegate's type can't be written by hand. */
type QuoteFinder = { findMany(args: any): Promise<any[]> };
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Every version in the families of `quoteIds` — and nothing else.
 *
 * This replaced "load the oldest 2,000 quote rows in the workspace and index
 * those", which silently dropped the history of every NEWER quote once a
 * workspace passed 2,000 rows: the newest quotes, the ones on page 1, were the
 * first to lose their Versions tab and superseded-successor link.
 *
 * Walks the revision links both ways (parent via `revisionOfId`, children via
 * rows naming a known id) until no new ids turn up. Families are short chains,
 * so this is a handful of small queries, bounded by the families asked for
 * rather than by the size of the workspace.
 *
 * The client is a PARAMETER — pass the scoped `prisma` the list uses, so the
 * tenant guard and soft-delete filter apply exactly as they did before.
 */
export async function loadQuoteVersions(client: { quote: QuoteFinder }, quoteIds: string[]): Promise<QuoteVersionRow[]> {
  const found = new Map<string, QuoteVersionRow>();
  const asked = new Set<string>();
  let frontier = [...new Set(quoteIds)];
  if (!frontier.length) return [];
  // Named explicitly as well, as loadBillToFleets does: the guard rewrites
  // nothing while enforcement is off, and revisionOfId has no tenant of its own.
  const tenantScope = await recoverableActiveTenantPredicate("quote version history");
  // ponytail: 50 hops caps a pathological chain; real families are a few revisions deep.
  for (let hop = 0; frontier.length && hop < 50; hop++) {
    frontier.forEach((id) => asked.add(id));
    const rows = (await client.quote.findMany({
      where: { ...tenantScope, OR: [{ id: { in: frontier } }, { revisionOfId: { in: frontier } }] },
      select: QUOTE_VERSION_SELECT,
    })) as QuoteVersionRow[];
    const next = new Set<string>();
    for (const row of rows) {
      found.set(row.id, row);
      if (!asked.has(row.id)) next.add(row.id);
      if (row.revisionOfId && !asked.has(row.revisionOfId)) next.add(row.revisionOfId);
    }
    frontier = [...next];
  }
  return [...found.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
