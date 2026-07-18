import { renderToBuffer } from "@react-pdf/renderer";
import { requireApiUser, apiAuthErrorResponse } from "@/lib/auth";
import { getBotUsername } from "@/lib/telegramMiniApp";
import TelegramSetupDoc from "@/lib/pdf/TelegramSetupDoc";

// react-pdf renders in Node (no browser) — keep this handler on the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireApiUser();
  } catch (err) {
    const r = apiAuthErrorResponse(err);
    if (r) return r;
    throw err;
  }

  // The guide references the URL Telegram will load — that's production, not a
  // dev/preview origin — so pin to the live domain when running locally.
  const origin = new URL(req.url).origin;
  const baseUrl = /localhost|127\.0\.0\.1|\.vercel\.app/.test(origin) ? "https://crm.denagocpt.co.za" : origin;
  const botUsername = await getBotUsername();

  const buf = Buffer.from(await renderToBuffer(<TelegramSetupDoc botUsername={botUsername} baseUrl={baseUrl} />));

  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="denago-telegram-mini-app-setup.pdf"',
    },
  });
}
