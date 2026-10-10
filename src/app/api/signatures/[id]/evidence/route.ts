import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { canAccessSignatureRequest } from "@/lib/signing/access";
import { buildEvidencePack } from "@/lib/signing/evidence";
import { getCompanyProfile } from "@/lib/companyProfile";
import { getRegionalSettings } from "@/lib/settings";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The evidence pack for one completed signing request: the sealed original, its
 * audit trail, the time-stamp token and a page explaining how to check them.
 *
 * NOT under /api/signing — that prefix is public to the proxy (it carries the
 * signers' tokened routes). This is a staff download and stays behind a session.
 *
 * Same two questions as the request page: may this person work with signature
 * requests at all, and may they open THIS one's record. "Not found" for both a
 * missing request and one that is not theirs, so the route cannot be used to
 * learn which ids exist.
 *
 * ── IT BINDS THE ACTING WORKSPACE, AND MUST ─────────────────────────────────
 *
 * A route handler has no layout above it to establish the workspace, and the
 * scope `getCurrentUser()` enters does not reach the frame that called it. The
 * permission lookup reads that scope — under enforcement a role assignment only
 * counts in the workspace being acted in — so without the wrapper it found no
 * workspace, therefore no roles, and answered Forbidden to everyone who is not
 * an owner, on their own documents included. (Owners skip the lookup, which is
 * why it looked fine.) The wrapper never widens: an unresolvable session runs
 * bare and the checks below still fail closed.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(async () => {
    const { id } = await params;
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await hasAnyPermission(user, "signing.view", "signing.manage"))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const req = await prisma.signatureRequest.findUnique({
      where: { id },
      include: {
        recipients: { orderBy: { order: "asc" } },
        events: { orderBy: { sequence: "asc" } },
      },
    });
    if (!req || req.deletedAt || !(await canAccessSignatureRequest(user, req))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (req.status !== "completed" || !req.signedPdfRef) {
      return NextResponse.json({ error: "Only a completed request has an evidence pack." }, { status: 409 });
    }

    const [company, regional] = await Promise.all([getCompanyProfile(req.tenantId), getRegionalSettings()]);
    let pack: Buffer;
    try {
      pack = await buildEvidencePack(
        { ...req, signedPdfRef: req.signedPdfRef },
        { name: user.name, workspace: company.name, regional },
      );
    } catch {
      return NextResponse.json({ error: "The signed PDF could not be read from storage." }, { status: 404 });
    }

    // A signed contract and its signers' details leaving the system is an event
    // worth a line on the customer's timeline.
    await logAudit({
      action: "signing.evidence_exported",
      summary: `Downloaded the evidence pack for “${req.title}”`,
      entityType: "SignatureRequest",
      entityId: req.id,
      contactId: req.contactId,
      user,
    });

    // Streamed: a buffered response over 4.5 MB is refused by the platform, and a
    // signed contract with photographs in it can be larger than that.
    return new NextResponse(new Blob([new Uint8Array(pack)]).stream(), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${req.title} — evidence.zip`)}`,
        "Content-Length": String(pack.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
