/**
 * Byte formatting for usage figures.
 *
 * Split out of `lib/tenantUsage.ts` because that module is `server-only` — it
 * talks to pg_class — and the Usage tab is a client component. Importing the
 * formatter from there would drag the whole server module into the client bundle
 * and fail the build. Types are safe to import across that line; runtime code is
 * not.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
