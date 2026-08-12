/**
 * `next/navigation` for a plain Node process.
 *
 * THIS STUB IS LOAD-BEARING, and getting it wrong would quietly invert the
 * harness's results.
 *
 * `redirect()` is how this codebase says NO. `requirePermission` calls
 * `redirect("/")` on a denied permission; `requireUser` calls
 * `redirect("/login")`; `requireLeadAccess` / `requireContactAccess` /
 * `requireQuoteAccess` / `requireJobCardAccess` each call `redirect("/<list>")`
 * when the caller may not touch that record. Under Next, redirect() throws an
 * object carrying a `digest` of `NEXT_REDIRECT;…`, and `unstable_rethrow` —
 * called on EVERY error inside `asActionResult` — recognises that digest and
 * rethrows it rather than converting it to `{ error }`.
 *
 * So a refused cross-tenant access does NOT come back as an error result: it
 * escapes the action as a throw. If this stub made redirect a no-op, an action
 * would sail past its own access guard and go on to mutate the row — and the
 * harness would report a catastrophic isolation failure that does not exist. If
 * instead `unstable_rethrow` swallowed it, every denial would look like a tidy
 * `{error}` and a genuine crash would be indistinguishable from a refusal.
 *
 * Both behaviours are therefore reproduced exactly, including the digest format,
 * and the thrown value is a class the harness can identify by instanceof.
 */

export class HarnessRedirect extends Error {
  readonly digest: string;
  readonly location: string;
  constructor(location: string, kind: "replace" | "push" = "replace", status = 307) {
    super(`NEXT_REDIRECT ${location}`);
    this.name = "HarnessRedirect";
    this.location = location;
    // Same shape Next uses, so any code sniffing the digest behaves identically.
    this.digest = `NEXT_REDIRECT;${kind};${location};${status};`;
  }
}

export class HarnessNotFound extends Error {
  readonly digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  constructor() {
    super("NEXT_NOT_FOUND");
    this.name = "HarnessNotFound";
  }
}

export function redirect(location: string): never {
  throw new HarnessRedirect(location, "replace");
}

export function permanentRedirect(location: string): never {
  throw new HarnessRedirect(location, "replace", 308);
}

export function notFound(): never {
  throw new HarnessNotFound();
}

/**
 * Next's real implementation rethrows control-flow errors (redirect / notFound)
 * and returns for everything else, letting the caller's catch handle real
 * failures. Reproduced precisely — see the header for why the distinction
 * decides whether a refusal reads as a refusal or as a leak.
 */
export function unstable_rethrow(error: unknown): void {
  if (error instanceof HarnessRedirect || error instanceof HarnessNotFound) throw error;
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_HTTP_ERROR_FALLBACK"))) {
    throw error;
  }
}

export const RedirectType = { push: "push", replace: "replace" } as const;

export function isRedirectError(error: unknown): boolean {
  return error instanceof HarnessRedirect;
}
