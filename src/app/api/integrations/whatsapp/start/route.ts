import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { connectOriginAllowed } from "@/lib/metaConnect";
import { startWhatsAppSignup } from "@/lib/whatsappConnect";

/**
 * Connect WhatsApp, step 1 (lib/whatsappConnect.ts) — on the domain the owner is using. The one-time state is stored
 * server-side with this origin and set as a cookie HERE, so /finish on this domain can prove the same browser started it.
 * Answers the popup's address; the Settings button opens it.
 */
export async function POST(request: Request) {
  const user = await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  if (!tenantId) return NextResponse.json({ error: "No active workspace." }, { status: 403 });
  const origin = new URL(request.url).origin;
  if (!(await connectOriginAllowed(tenantId, origin))) return NextResponse.json({ error: "Open Settings from your workspace's own address and try again." }, { status: 400 });
  const started = await startWhatsAppSignup({ tenantId, userId: user.id, origin });
  if (!started) return NextResponse.json({ error: "Connect WhatsApp isn't set up on this CRM yet." }, { status: 409 });
  const jar = await cookies();
  jar.set("wa_signup", started.state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 900, path: "/api/integrations/whatsapp" });
  return NextResponse.json({ popupUrl: started.popupUrl });
}
