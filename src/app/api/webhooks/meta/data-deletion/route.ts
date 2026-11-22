import { NextRequest, NextResponse } from "next/server";
import { parseMetaSignedRequest } from "@/lib/metaSignedRequest";
import { deleteMetaUserData, metaPlatformSecret } from "@/lib/metaDataDeletion";
import { dataDeletionStatusUrl } from "@/lib/platformLegal";
import { logError } from "@/lib/errorLog";

/**
 * Meta's data-deletion callback for the platform's app (lib/metaDataDeletion.ts). Public like every webhook; acted on
 * only when the signed request verifies with the platform app's secret. Answers Meta's format: a status URL and a
 * confirmation code.
 */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const signed = String(form?.get("signed_request") ?? "");
  const secret = await metaPlatformSecret();
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  const request = parseMetaSignedRequest(signed, secret);
  if (!request) return NextResponse.json({ error: "Invalid signed request" }, { status: 400 });
  try {
    const { code } = await deleteMetaUserData(request.userId);
    return NextResponse.json({ url: dataDeletionStatusUrl(code), confirmation_code: code });
  } catch (error) {
    await logError("meta-data-deletion", error).catch(() => {});
    return NextResponse.json({ error: "Could not complete the request" }, { status: 500 });
  }
}
