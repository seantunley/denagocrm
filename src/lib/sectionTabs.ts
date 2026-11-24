/**
 * Which tab a page of tabbed sections opens on (components/SectionTabs.tsx).
 * Pure. The tab is carried in the address after the `#`, so a link to
 * `/settings/assistant#learned` opens that section and Back/Forward work —
 * and a link written before the page had tabs still lands in the right place.
 */
export function tabFromHash(hash: string, ids: readonly string[], fallback: string): string {
  let wanted: string;
  try {
    wanted = decodeURIComponent(hash.replace(/^#/, "")).trim();
  } catch {
    // A malformed fragment (`#%E0%A4%A`) is a bad link, not a reason to break the page: open the first tab (review of #1223).
    return fallback;
  }
  return ids.includes(wanted) ? wanted : fallback;
}

/** The tab an arrow key moves to: left and right wrap round, Home and End jump to the ends. */
export function tabAfterKey(key: string, ids: readonly string[], current: string): string | null {
  const at = ids.indexOf(current);
  if (at < 0 || ids.length === 0) return null;
  if (key === "ArrowRight") return ids[(at + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(at - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}
