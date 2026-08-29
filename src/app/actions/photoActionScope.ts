import "server-only";
import { requireUser } from "@/lib/auth";
import { withActingStaffScope } from "@/lib/actingScope";

/**
 * Run one user-originated photo action inside a recovered staff workspace and
 * make the authentication boundary explicit to the Server Action inventory.
 *
 * withActingStaffScope revalidates the session before recovering a tenant scope;
 * requireUser runs INSIDE that recovered frame so the action also carries the
 * same explicit auth gate as every other exported Server Action. Neither helper
 * grants record access — quote/job-card permissions remain in the delegated
 * action and token route.
 */
export async function withPhotoActionScope<T>(fn: () => Promise<T>): Promise<T> {
  return withActingStaffScope(async () => {
    await requireUser();
    return fn();
  });
}
