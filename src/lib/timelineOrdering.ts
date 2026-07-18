export type TimelineOrderItem = {
  pinnedAt?: Date | null;
  pending?: boolean;
  when: Date;
};

export function compareTimelineItems(
  a: TimelineOrderItem,
  b: TimelineOrderItem,
): number {
  const aPinned = Boolean(a.pinnedAt);
  const bPinned = Boolean(b.pinnedAt);
  if (aPinned !== bPinned) return aPinned ? -1 : 1;

  if (aPinned && bPinned) {
    const pinnedDiff = b.pinnedAt!.getTime() - a.pinnedAt!.getTime();
    if (pinnedDiff !== 0) return pinnedDiff;
  }

  const aPending = Boolean(a.pending);
  const bPending = Boolean(b.pending);
  if (aPending !== bPending) return aPending ? -1 : 1;

  return b.when.getTime() - a.when.getTime();
}
