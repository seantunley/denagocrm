"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Link2, Loader2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { generateTelegramLinkCode, unlinkTelegram } from "@/app/actions/telegram";

export default function TelegramLinkPanel({
  linked,
  telegramUserId,
}: {
  linked: boolean;
  telegramUserId: string | null;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const generate = () =>
    start(async () => {
      const result = await generateTelegramLinkCode();
      setCode(result.code);
      setCopied(false);
    });

  const unlink = () =>
    start(async () => {
      await unlinkTelegram();
      setCode(null);
    });

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is still shown to type by hand */
    }
  };

  if (linked) {
    return (
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <Check className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Telegram linked</p>
            <p className="text-xs text-muted-foreground">
              Opening the Mini App signs you straight in{telegramUserId ? ` (ID ${telegramUserId})` : ""}.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={unlink} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5" />}
            Unlink
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Link2 className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Link your Telegram</p>
          <p className="text-xs text-muted-foreground">
            Generate a one-time code, open the Denago Mini App in Telegram, and type it in. After that the app
            signs you in automatically — no password on your phone.
          </p>
        </div>
      </div>

      {code ? (
        <div className="mt-4 rounded-lg border border-border bg-background/40 p-4 text-center">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Your link code</p>
          <div className="mt-1 flex items-center justify-center gap-3">
            <span className="font-mono text-2xl font-semibold tracking-[0.3em] text-foreground">{code}</span>
            <Button variant="ghost" size="sm" onClick={copy} title="Copy code">
              {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Valid for about 10 minutes — enter it in the Mini App.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={generate} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            New code
          </Button>
        </div>
      ) : (
        <Button className="mt-4" onClick={generate} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          Generate link code
        </Button>
      )}
    </div>
  );
}
