// Empty stand-in for Next's `server-only` / `client-only` marker packages.
//
// Those packages exist only to make a build FAIL when server code is pulled into
// a client bundle (or vice-versa); at runtime they export nothing. They aren't
// resolvable in a plain Node/tsx process (Next vendors them and swaps them via an
// RSC export condition), so a tsx integration script that transitively imports a
// "server-only" module — e.g. scripts/test-rbac.ts → permissions.ts →
// modules/enabled.ts — crashes with MODULE_NOT_FOUND.
//
// tsconfig.scripts.json maps both specifiers here so the tsx scripts resolve them
// to this no-op. The real tsconfig.json is untouched, so the Next build keeps the
// genuine guard.
export {};
