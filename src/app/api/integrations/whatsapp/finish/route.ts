import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { connectWhatsAppNumber } from "@/lib/whatsappConnect";
import { validHandoff } from "@/lib/whatsappSignupMessage";
import { logAudit } from "@/lib/audit";
import { logError } from "@/lib/errorLog";

/**
 * Connect WhatsApp, step 3 — the Settings page posts what the popup handed back, on the workspace's own domain, behind
 * the owner's session. The state must match the cookie set here at step 1 (the same browser) and be this workspace's,
 * unexpired and unused (lib/whatsappConnect.ts spends it). Nothing in the body is trusted beyond its shape.
 */
export async function POST(request: Request) {
  const user = await requireTenantOwner();
  const jar = await cookies();
  const cookieState = jar.get("wa_signup")?.value;
  jar.delete({ name: "wa_signup", path: "/api/integrations/whatsapp" });
  const handoff = validHandoff(await request.json().catch(() => null));
  const tenantId = await getActiveTenantId();
  if (!tenantId || !handoff || !cookieState || cookieState !== handoff.state) {
    return NextResponse.json({ error: "That sign-up could not be checked — press Connect WhatsApp again." }, { status: 400 });
  }
  try {
    const number = await connectWhatsAppNumber({ tenantId, ...handoff });
    await logAudit({ action: "integration.whatsapp_connected", summary: `Connected the WhatsApp number ${number}`, user });
    return NextResponse.json({ connected: number });
  } catch (error) {
    // Meta's reason only — never a token, code or PIN.
    const message = error instanceof Error ? error.message : "Connect WhatsApp could not be completed.";
    await logError("whatsapp-connect", message).catch(() => {});
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
