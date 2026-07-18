import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { validateInitData } from "@/lib/telegramMiniApp";
import { createSessionCookie } from "@/lib/auth";
import { getUserSecurityState, recordSuccessfulLogin } from "@/lib/userSecurity";
import {
  OTP_VERIFY_POLICY,
  checkRateLimit,
  getRequestIp,
  rateLimitKey,
  registerRateLimitAttempt,
} from "@/lib/rateLimit";
import { logAudit } from "@/lib/audit";

/**
 * One-time link. The user generated a code in web Settings (already past
 * password + 2FA there); here they present it from inside the Mini App. Valid
 * `initData` proves the Telegram identity, the code proves it's the same person
 * who was authenticated on web — so we bind the two and sign them in. No
 * password or second factor is re-entered in Telegram.
 */
export async function POST(req: NextRequest) {
  const ip = await getRequestIp();
  const key = rateLimitKey("tg-miniapp-link", ip);
  if (!(await checkRateLimit(key)).allowed) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let body: { initData?: string; code?: string };
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
    await registerRateLimitAttempt(key, OTP_VERIFY_POLICY);
    return NextResponse.json({ error: "Could not verify Telegram launch." }, { status: 401 });
  }

  const code = String(body.code ?? "").trim().toUpperCase().replace(/\s/g, "");
  if (code.length < 6) {
    await registerRateLimitAttempt(key, OTP_VERIFY_POLICY);
    return NextResponse.json({ error: "Enter the code from CRM Settings." }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { telegramLinkCode: code, telegramLinkExpires: { gt: new Date() } },
  });
  if (!user) {
    await registerRateLimitAttempt(key, OTP_VERIFY_POLICY);
    return NextResponse.json({ error: "That code is wrong or has expired. Generate a new one in Settings." }, { status: 400 });
  }

  // Guard against binding a Telegram account already linked to someone else.
  const existing = await prisma.user.findUnique({ where: { telegramUserId: result.user.id } });
  if (existing && existing.id !== user.id) {
    return NextResponse.json({ error: "This Telegram account is already linked to another user." }, { status: 409 });
  }

  const security = await getUserSecurityState(user.id);
  if (!security || security.disabledAt) {
    return NextResponse.json({ error: "This account is not available." }, { status: 403 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { telegramUserId: result.user.id, telegramLinkCode: null, telegramLinkExpires: null },
  });
  await recordSuccessfulLogin(user.id);
  await createSessionCookie(user, { pwa: true });
  await logAudit({
    action: "auth.telegram_linked",
    summary: `Linked Telegram account @${result.user.username ?? result.user.id} and signed in via the Mini App`,
    userName: user.name,
  });
  return NextResponse.json({ ok: true });
}
