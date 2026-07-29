/**
 * The shape a server action returns to report an EXPECTED outcome.
 *
 * Split out of lib/actionResult.ts because that module is `server-only` and this
 * type is needed by client components (<SaveForm>). A bare `import type` is
 * erased at compile time and would be safe, but keeping the shared contract in a
 * neutral module means nobody has to reason about that to know it is fine.
 */
export type ActionResult = {
  error?: string;
  success?: string;
  /**
   * Where to navigate after a SUCCESSFUL mutation.
   *
   * Returned rather than performed with `redirect()`, because a thrown redirect
   * is indistinguishable from the ones the auth guards throw: an expired session
   * redirects to /login, a revoked permission to /, denied record access to
   * /leads. Treating any redirect as success meant "Lead saved" could appear when
   * the mutation had never run. Only the action itself knows it actually saved,
   * so only the action may claim it.
   */
  redirectTo?: string;
};
