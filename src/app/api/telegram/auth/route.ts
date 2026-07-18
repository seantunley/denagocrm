import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateInitData } from "@/lib/telegramMiniApp";
import { createSessionCookie } from "@/lib/auth";
import { getUserSecurityState, recordSuccessfulLogin } from "@/lib/userSecurity";
import {
  LOGIN_POLICY,
  checkRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";
import { logAudit } from "@/lib/audit";

/**
 * Mini App auto-login. The client posts the signed `initData` Telegram handed
 * it at launch; if that Telegram account is linked to a CRM user we mint the
 * normal session cookie. Unlinked accounts get `{ linked: false }` so the client
 * can show the one-time link step. No password ever crosses this boundary.
 */
export async function POST(req: NextRequest) {
  const ip = await getRequestIp();
  const key = rateLimitKey("tg-miniapp-auth", ip);
  if (!(await checkRateLimit(key)).allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let body: { initData?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }

  const result = await validateInitData(String(body.initData ?? ""));
  if (!result.ok) {
    if (result.reason === "no_token") {
      return NextResponse.json({ error: "Telegram is not configured on this CRM." }, { status: 503 });
    }
    await registerRateLimitAttempt(key, LOGIN_POLICY);
    return NextResponse.json({ error: "Could not verify Telegram launch." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({ where: { telegramUserId: result.user.id } });
  if (!user) return NextResponse.json({ ok: true, linked: false });

  const security = await getUserSecurityState(user.id);
  if (!security || security.disabledAt) {
    return NextResponse.json({ error: "This account is not available." }, { status: 403 });
  }

  await recordSuccessfulLogin(user.id);
  await createSessionCookie(user, { pwa: true });
  await logAudit({ action: "auth.telegram_login", summary: "Signed in via the Telegram Mini App", userName: user.name });
  return NextResponse.json({ ok: true, linked: true });
}
