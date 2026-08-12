/**
 * WHO THE HARNESS IS CURRENTLY PRETENDING TO BE.
 *
 * The harness drives real server actions, and a real server action discovers its
 * caller exactly one way: `cookies()` from `next/headers`, read inside
 * `getCurrentUser()`. So "act as tenant A's user" is expressed here as "make
 * `cookies()` return A's session cookie", and nothing downstream is told anything
 * else. Every tenant decision the action makes — the RBAC lookup, the tenant
 * scope entered by `establishStaffTenantScope`, the tenantId stamped by
 * `withTenantWrite` — is then derived by the application's own code from that one
 * value, which is the entire point. A harness that passed a tenantId in by hand
 * would be testing its own plumbing.
 *
 * AsyncLocalStorage rather than a module-level variable so two acting contexts
 * can never bleed into one another, and so an `await` inside an action cannot
 * lose the identity mid-call.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ActingSession = {
  /** Signed JWT exactly as the browser would hold it in `denago_session`. */
  cookieValue: string;
  /** For diagnostics only — never read by application code. */
  label: string;
};

const storage = new AsyncLocalStorage<ActingSession>();

export function runAsSession<T>(session: ActingSession, fn: () => Promise<T>): Promise<T> {
  // `async () => fn()` rather than `fn`: with a non-async callback,
  // storage.run() returns the promise immediately and continuations can resolve
  // outside the store. The repo's own test-tenant-e2e.ts documents this same trap.
  return storage.run(session, async () => fn());
}

export function currentActingSession(): ActingSession | undefined {
  return storage.getStore();
}
