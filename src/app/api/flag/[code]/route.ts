import { NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";

/**
 * A country flag, for any country, as an SVG.
 *
 * WHY NOT EMOJI. The first version rendered a regional-indicator emoji pair, on
 * the reasoning that it needs no assets and covers every country. It does not
 * work: WINDOWS SHIPS NO COUNTRY-FLAG FONT, so Chrome and Edge on Windows draw
 * the two letters — "ZA" — instead of a flag. That is most of this app's users
 * seeing a bug rather than a flag, which is exactly what was reported.
 *
 * WHY NOT BUNDLED SVGs. The old strip had two, checked into /public, for the two
 * countries it hardcoded. A tenant can now pick anywhere, so that approach needs
 * roughly 250 files committed for the handful any one workspace will use.
 *
 * WHY A PROXY. Same reasoning as the city search next door: fetching flagcdn
 * from the browser would mean widening `connect-src`/`img-src` in lib/csp.ts,
 * which is deliberate about listing a host only when something needs it. Serving
 * it from our own origin keeps the policy unchanged and means the tenant's
 * browser never talks to a third party.
 *
 * Cached hard, because a country's flag is not news: a year in the browser and
 * a year at the edge. If one ever does change, the country code stays the same
 * and the fix is a redeploy, not a stale-cache incident.
 */

const UPSTREAM = "https://flagcdn.com";

/** A 1x1 transparent SVG, so a missing flag is a gap rather than a broken image. */
const BLANK = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

function blank() {
  return new NextResponse(BLANK, {
    headers: {
      "content-type": "image/svg+xml",
      // Not cached as long as a real flag: a code that is wrong today may be
      // right after the next deploy.
      "cache-control": "public, max-age=300",
    },
  });
}

export async function GET(_request: Request, { params }: { params: Promise<{ code: string }> }) {
  /*
   * Authenticated, like every other non-public route here.
   *
   * A flag is not sensitive, and the argument for leaving it open is that it
   * is only an image. But this endpoint makes an OUTBOUND request on demand,
   * and the strip it feeds only ever renders inside the signed-in shell - so
   * the guard costs nothing real and keeps the route out of the set that has
   * to be reasoned about as public.
   */
  try {
    await requireApiUser();
  } catch (err) {
    return apiAuthErrorResponse(err) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await params;

  // Two ASCII letters, and nothing else, ever reaches the URL below. The code
  // comes from a tenant setting, so it is caller-influenced input being put into
  // an outbound request path.
  if (!/^[A-Za-z]{2}$/.test(code)) return blank();
  const iso = code.toLowerCase();

  try {
    const upstream = await fetch(`${UPSTREAM}/${iso}.svg`, {
      signal: AbortSignal.timeout(5000),
      // Flags do not change; let the platform cache handle repeats.
      next: { revalidate: 60 * 60 * 24 * 30 },
    });
    if (!upstream.ok) return blank();

    const svg = await upstream.text();
    // A response that is not an SVG is not something to hand back as one.
    if (!svg.trimStart().startsWith("<svg")) return blank();

    return new NextResponse(svg, {
      headers: {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // No flag is a small gap in a strip. A failure here must not be able to
    // affect the page it sits on.
    return blank();
  }
}
