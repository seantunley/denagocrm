/**
 * The shape a server action returns to report an EXPECTED outcome.
 *
 * Split out of lib/actionResult.ts because that module is `server-only` and this
 * type is needed by client components (<SaveForm>). A bare `import type` is
 * erased at compile time and would be safe, but keeping the shared contract in a
 * neutral module means nobody has to reason about that to know it is fine.
 */
export type ActionResult = { error?: string; success?: string };
