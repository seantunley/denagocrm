/** A quote stays signable through the end of its valid-until day. */
export function quoteExpired(validUntil: Date | null): boolean {
  if (!validUntil) return false;
  const end = new Date(validUntil);
  end.setHours(23, 59, 59, 999);
  return Date.now() > end.getTime();
}
