import { NextRequest, NextResponse } from "next/server";
import { readFile } from "@/lib/storage";
import { verifyOutboundMediaToken } from "@/lib/outboundMedia";

/**
 * Serves ONE outbound attachment to the messaging provider, and to nobody else
 * who has not been handed the URL.
 *
 * Meta does not accept bytes on its send endpoint — it accepts a URL and fetches
 * it itself, anonymously, from its own infrastructure. So this route cannot be
 * authenticated in the usual sense, and the URL has to carry its own authority:
 * an HMAC over the storage ref, the content type and an expiry. No database
 * lookup, nothing to enumerate, and useless once it expires.
 *
 * Deliberately narrow:
 *   - only refs that were SIGNED by this application are served, so this cannot
 *     become a general file-read primitive the way an `?path=` parameter would;
 *   - the content type comes from the signed claim, not from the request, so a
 *     caller cannot re-label somebody's PDF as HTML and have a browser run it;
 *   - `nosniff` and an attachment disposition, because the one thing worse than
 *     serving the file is serving it as something a browser will execute;
 *   - `no-store` on the response, so a shared cache never keeps a copy alive
 *     past the expiry the token encodes.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { token } = await params;
  const claim = verifyOutboundMediaToken(token, secret);
  // One answer for a bad signature, a tampered payload and an expired link:
  // distinguishing them tells a prober which part to keep trying.
  if (!claim) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const buffer = await readFile(claim.ref);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": claim.contentType,
        "Content-Length": String(buffer.length),
        "Content-Disposition": "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
