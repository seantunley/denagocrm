// Pure store-selection + merge helpers for the backup blob pipeline. No
// @vercel/blob or env access, so they're unit-testable and used by storage.ts.
//
// Two Blob stores exist during the staged BLOB_PRIVATE rollout: the legacy
// PUBLIC store and the new PRIVATE store. The rules that keep the cutover safe:
//  - the ACTIVE store (what we write to now) is private iff BLOB_PRIVATE is on;
//  - existence checks for NEW writes and live retention touch the ACTIVE store
//    ONLY — installing the private token before flipping the flag must not
//    change public-mode behaviour;
//  - cross-store listing is for restore/verify selection only.

export type StoreTokens = { publicToken?: string; privateToken?: string };

export function activeStore(privateMode: boolean): "private" | "public" {
  return privateMode ? "private" : "public";
}

/** The RW token for the store we currently write to. */
export function activeStoreToken(privateMode: boolean, tokens: StoreTokens): string | undefined {
  return privateMode ? tokens.privateToken : tokens.publicToken;
}

/** Whether the active store has a usable write token (fails closed in private mode). */
export function activeWriteTokenPresent(privateMode: boolean, tokens: StoreTokens): boolean {
  return Boolean(activeStoreToken(privateMode, tokens));
}

/** Merge blob lists, keeping the FIRST occurrence of each pathname. */
export function dedupeByPathname<T extends { pathname: string }>(...lists: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.pathname)) continue;
      seen.add(item.pathname);
      out.push(item);
    }
  }
  return out;
}
