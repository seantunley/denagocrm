import { NextRequest, NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/auth";
import { DEFAULT_BRAND, brandForHost, brandForTenant, brandIcons } from "@/lib/tenantBrand";

export const dynamic = "force-dynamic";

/**
 * The tab icon a browser asks for when a page names none — a printed quote or
 * document (a route handler's bare HTML), a PDF, any raw response. This used to
 * be Next.js's stock favicon.ico: the black Vercel triangle, on every printed
 * quote's tab (seen 2026-10-07). Now it is the same icon the pages use
 * (brandIcons): the signed-in workspace's logo, else the domain's workspace, else
 * the platform's own icon. Never throws — any failure falls to the platform icon.
 */
export async function GET(req: NextRequest) {
  const fromSession = await getActiveTenantId()
    .then((id) => (id ? brandForTenant(id) : null))
    .catch(() => null);
  const brand = fromSession?.tenantId
    ? fromSession
    : await brandForHost(req.headers.get("host")).catch(() => DEFAULT_BRAND);
  const res = NextResponse.redirect(new URL(brandIcons(brand).icon, req.url), 307);
  // Per person and domain, and a logo can change: a short private cache.
  res.headers.set("Cache-Control", "private, max-age=300");
  return res;
}
