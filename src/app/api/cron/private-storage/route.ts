import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { logError } from "@/lib/errorLog";
import { blobMigrationIo, movePublicFilesToPrivate } from "@/lib/privateMigration";

export const maxDuration = 300;

/** Stop starting new files with this much of the platform limit left. */
const ROUTE_BUDGET_MS = 270_000;

/**
 * Moves files from the public Blob store to the private one, verified, in
 * batches until none are left (see lib/privateMigration.ts).
 *
 * Does nothing until BLOB_PRIVATE is on — new uploads must already be going to
 * the private store, or the public store would refill behind it. It touches no
 * database, so a tick with nothing left to move is one storage listing and
 * never wakes the database (a failure is logged, which does).
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const publicToken = process.env.BLOB_READ_WRITE_TOKEN;
  const privateToken = process.env.BLOB_PRIVATE_READ_WRITE_TOKEN;
  if (process.env.BLOB_PRIVATE !== "true" || !publicToken || !privateToken) {
    return NextResponse.json({ ok: true, skipped: "private storage is not switched on" });
  }

  const deadline = Date.now() + ROUTE_BUDGET_MS;
  try {
    const pass = await movePublicFilesToPrivate({
      io: blobMigrationIo(publicToken, privateToken),
      shouldStop: () => Date.now() >= deadline,
    });
    if (pass.failed.length) {
      // One entry per run, not per file; the paths name storage objects, not clients.
      const first = pass.failed[0];
      await logError(
        "private-storage-move",
        new Error(`${pass.failed.length} file(s) could not be moved; first: ${first.pathname}: ${first.error}`),
        undefined,
        { alert: false },
      );
    }
    return NextResponse.json({
      ok: true,
      moved: pass.moved,
      verifiedEarlierCopy: pass.verifiedEarlierCopy,
      keptPublicAssets: pass.keptPublicAssets,
      failed: pass.failed.length,
      done: pass.walkedEverything && pass.failed.length === 0,
    });
  } catch (error) {
    await logError("private-storage-move", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
