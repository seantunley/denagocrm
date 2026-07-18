import { Send, ExternalLink, FileDown } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getBotUsername } from "@/lib/telegramMiniApp";
import { getSetting } from "@/lib/settings";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import TelegramLinkPanel from "./TelegramLinkPanel";

export const dynamic = "force-dynamic";

export default async function TelegramSettingsPage() {
  const user = await requireUser();
  const [tokenConfigured, botUsername] = await Promise.all([
    getSetting("TELEGRAM_BOT_TOKEN").then(Boolean),
    getBotUsername(),
  ]);
  const linked = Boolean(user.telegramUserId);
  const botLink = botUsername ? `https://t.me/${botUsername}` : null;

  return (
    <SettingsWorkspace
      current="telegram"
      title="Telegram"
      description="Open the CRM as an app inside Telegram — no password to type on your phone."
      groups={SETTINGS_NAV_GROUPS}
    >
      <div className="space-y-5">
        {!tokenConfigured && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground">
            No Telegram bot token is saved yet. Add <span className="font-mono text-xs">TELEGRAM_BOT_TOKEN</span> under
            Settings → Integrations first — the Mini App uses that bot.
          </div>
        )}

        <TelegramLinkPanel linked={linked} telegramUserId={user.telegramUserId} />

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Send className="size-5" />
              </span>
              <p className="text-sm font-semibold text-foreground">One-time setup (owner)</p>
            </div>
            <a
              href="/api/pdf/telegram-setup"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <FileDown className="size-3.5" /> Setup guide (PDF)
            </a>
          </div>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              In Telegram, open <span className="text-foreground">@BotFather</span>
              {botLink && (
                <>
                  {" "}
                  and select your bot{" "}
                  <a href={botLink} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    @{botUsername} <ExternalLink className="inline size-3" />
                  </a>
                </>
              )}
              .
            </li>
            <li>
              Send <span className="font-mono text-xs text-foreground">/newapp</span>, pick the bot, and set the Web App
              URL to <span className="font-mono text-xs text-foreground">https://crm.denagocpt.co.za/tg</span>.
            </li>
            <li>
              Give it a short name (e.g. <span className="font-mono text-xs text-foreground">crm</span>) — BotFather
              returns a link like{" "}
              <span className="font-mono text-xs text-foreground">
                https://t.me/{botUsername ?? "yourbot"}/crm
              </span>
              . That link opens the CRM as an app.
            </li>
            <li>
              Optional: BotFather → <span className="text-foreground">Bot Settings → Menu Button</span> → set the URL to
              the same <span className="font-mono text-xs text-foreground">/tg</span> page for a permanent “Open” button
              in the bot chat.
            </li>
            <li>Each staff member links once here, then the app signs them in automatically.</li>
          </ol>
          <p className="mt-4 text-xs text-muted-foreground/70">
            Works in the Telegram mobile and desktop apps. (Telegram Web in a browser needs a frame-ancestors header
            change — ask if you want it.)
          </p>
        </div>
      </div>
    </SettingsWorkspace>
  );
}
