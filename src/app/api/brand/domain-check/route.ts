import { NextRequest, NextResponse } from "next/server";
import { domainProof } from "@/lib/domainCheck";
import { normaliseHost } from "@/lib/tenantBrand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Is this hostname actually served by this deployment?"
 *
 * PUBLIC BY NECESSITY, and the necessity is the whole point: it is fetched over
 * the open internet, by us, at the hostname being verified, precisely to find
 * out whether that hostname reaches us at all. A route behind authentication
 * could not answer the question — there is no session on a domain that has not
 * been set up yet.
 *
 * What it discloses is nothing. It echoes the Host header the CALLER already
 * chose, plus an HMAC of that header keyed on SESSION_SECRET. The HMAC is not a
 * secret to protect; it is the answer to "did a server holding our key reply?",
 * which is only meaningful to someone who can compute it independently — us.
 * A stranger fetching this learns that a hostname points at this application,
 * which they could equally learn by loading its login page.
 *
 * It writes nothing, reads no database, and takes no parameters.
 */
export async function GET(req: NextRequest) {
  // The Host header as the edge saw it — this is the value under test. Falling
  // back to the URL's hostname keeps the route honest behind a proxy that
  // rewrites Host, where the URL is the better witness of what was requested.
  const host = normaliseHost(req.headers.get("host") ?? req.nextUrl.hostname);
  if (!host) {
    return NextResponse.json({ ok: false, error: "no host" }, { status: 400 });
  }
  let proof: string;
  try {
    proof = domainProof(host);
  } catch {
    // SESSION_SECRET missing. 503 rather than 200-without-proof: a verifier that
    // treated a proofless success as a pass would mark every domain verified on
    // a misconfigured deployment.
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  return NextResponse.json(
    { ok: true, host, proof },
    { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}
