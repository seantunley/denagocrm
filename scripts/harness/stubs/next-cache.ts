/**
 * `next/cache` for a plain Node process.
 *
 * Cache invalidation is a no-op here and legitimately so: the harness asserts on
 * database state, never on rendered output, so what a revalidated path would have
 * re-rendered is not a fact under test. What matters is that the signatures match
 * the call sites — `revalidatePath` is called with a second argument in
 * dashboardConfig.ts (`revalidatePath("/", "layout")`), and a stub that only
 * accepted one would be a TypeScript error rather than a runtime one, which is
 * the good outcome but only if the parameter is actually declared.
 *
 * Calls are counted rather than discarded so a "the action returned success but
 * never invalidated anything" regression stays observable if we ever want it.
 */

export type RevalidateKind = "layout" | "page";

const calls: Array<{ kind: "path" | "tag"; value: string; type?: RevalidateKind }> = [];

export function revalidatePath(path: string, type?: RevalidateKind): void {
  calls.push({ kind: "path", value: path, type });
}

export function revalidateTag(tag: string): void {
  calls.push({ kind: "tag", value: tag });
}

export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

export function unstable_noStore(): void {}

export function __revalidations(): ReadonlyArray<{ kind: "path" | "tag"; value: string; type?: RevalidateKind }> {
  return calls;
}

export function __resetRevalidations(): void {
  calls.length = 0;
}
