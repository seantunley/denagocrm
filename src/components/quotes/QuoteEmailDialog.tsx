"use client";

import { useState, useTransition } from "react";
import { Eye, Loader2, Mail, Paperclip, Send } from "lucide-react";
import { toast } from "sonner";
import { quoteEmailDraft, sendQuoteEmail } from "@/app/actions/quoteEmail";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle, ResponsiveDialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FeedbackBanner } from "@/components/visual-system";

/**
 * "Email quote": opening it only fills in a draft. Nothing reaches the customer
 * until Send is clicked, after they have seen the To, subject, message and the
 * attached PDF (Preview opens the same document that gets attached).
 */
export default function QuoteEmailDialog({
  quoteId,
  disabled,
  disabledReason,
  onSent,
}: {
  quoteId: string;
  disabled?: boolean;
  disabledReason?: string;
  onSent?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ to: string; subject: string; body: string; fileName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();

  function openDialog() {
    setOpen(true);
    setDraft(null);
    setError(null);
    startLoading(async () => {
      const result = await quoteEmailDraft(quoteId).catch(() => ({ ok: false as const, error: "Couldn't prepare the email." }));
      if (result.ok) setDraft({ to: result.to, subject: result.subject, body: result.body, fileName: result.fileName });
      else setError(result.error);
    });
  }

  function send() {
    if (!draft) return;
    setError(null);
    startSending(async () => {
      const result = await sendQuoteEmail(quoteId, { to: draft.to, subject: draft.subject, body: draft.body }).catch(
        () => ({ ok: false as const, error: "The email could not be sent." }),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(result.message);
      setOpen(false);
      onSent?.();
    });
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={openDialog} disabled={disabled} title={disabled ? disabledReason : undefined}>
        <Mail />Email quote
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (!sending) setOpen(next); }}>
        <ResponsiveDialogContent className="z-[110] sm:max-w-xl">
          <DialogHeader className="text-left">
            <DialogTitle>Email quote</DialogTitle>
            <DialogDescription>Check what the customer will receive. Nothing is sent until you press Send.</DialogDescription>
          </DialogHeader>
          {error && <FeedbackBanner tone="danger" title="Not sent">{error}</FeedbackBanner>}
          {loading && !draft ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Preparing the email…</div>
          ) : draft ? (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="quote-email-to">To</Label>
                <Input id="quote-email-to" inputMode="email" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} placeholder="customer@example.com" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quote-email-subject">Subject</Label>
                <Input id="quote-email-subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quote-email-body">Message</Label>
                <Textarea id="quote-email-body" rows={9} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
                <p className="text-xs text-muted-foreground">Your email signature is added below the message. Default wording: Settings → Email → Quote email.</p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2"><Paperclip className="size-4 shrink-0" /><span className="truncate">{draft.fileName}</span></span>
                <a href={`/quotes/${quoteId}/print`} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"><Eye className="size-3.5" />Preview</a>
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={sending}>Cancel</Button>
                <Button type="button" onClick={send} disabled={sending || !draft.to.trim()}>
                  {sending ? <Loader2 className="animate-spin" /> : <Send />}{sending ? "Sending…" : "Send"}
                </Button>
              </div>
            </div>
          ) : null}
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}
