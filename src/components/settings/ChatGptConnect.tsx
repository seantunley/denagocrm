"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { disconnectChatGpt, pollChatGptLogin, startChatGptLogin, testChatGpt } from "@/app/actions/codex";
import type { CodexStatus } from "@/lib/codex";

/**
 * Connect a ChatGPT subscription for lead research.
 *
 * The sign-in is OpenAI's device-code flow: this shows a short code and a link,
 * the owner approves at OpenAI in any browser, and the page polls until that
 * happens. Nothing waits on the server — a serverless function cannot hold a
 * request open for the fifteen minutes a person might take.
 */
export default function ChatGptConnect({ initial }: { initial: CodexStatus }) {
  const [status, setStatus] = useState<CodexStatus>(initial);
  const [intervalMs, setIntervalMs] = useState(5000);
  const [busy, start] = useTransition();
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Poll while a sign-in is pending — including one resumed after a reload.
  useEffect(() => {
    if (status.state !== "pending") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const result = await pollChatGptLogin().catch(() => ({ state: "pending" as const }));
      if (cancelled) return;
      if ("error" in result) {
        toast.error(result.error);
        setStatus({ state: "disconnected" });
      } else if (result.state === "connected") {
        toast.success("ChatGPT connected. Lead research now runs on your subscription.");
        // The server holds the account id and model; a reload picks them up.
        window.location.reload();
      } else if (result.state === "expired") {
        toast.error("The sign-in code expired. Start again.");
        setStatus({ state: "disconnected" });
      } else {
        timer = window.setTimeout(tick, intervalMs);
      }
    };
    let timer = window.setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [status, intervalMs]);

  function connect() {
    start(async () => {
      const result = await startChatGptLogin();
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setIntervalMs(result.intervalMs);
      setStatus({
        state: "pending",
        userCode: result.userCode,
        verificationUrl: result.verificationUrl,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
    });
  }

  function test() {
    setTestResult(null);
    start(async () => {
      const result = await testChatGpt();
      setTestResult(result.ok ? { ok: true, text: result.reply } : { ok: false, text: result.error });
    });
  }

  function disconnect() {
    start(async () => {
      const { revoked } = await disconnectChatGpt();
      setStatus({ state: "disconnected" });
      setTestResult(null);
      if (revoked) toast.success("ChatGPT disconnected and its sign-in revoked.");
      else {
        toast.warning(
          "Disconnected here, but OpenAI couldn't be reached to revoke the sign-in. You can also remove it from your ChatGPT account's security settings.",
        );
      }
    });
  }

  if (status.state === "pending") {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-sm">
        <p className="font-medium">1. Open this link and sign in with your ChatGPT account:</p>
        <a
          href={status.verificationUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-primary underline underline-offset-2"
        >
          {status.verificationUrl}
        </a>
        <p className="mt-3 font-medium">2. Enter this code:</p>
        <p className="mt-1 select-all font-mono text-2xl tracking-widest">{status.userCode}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          Waiting for you to approve it at OpenAI… This page updates by itself. The code expires in 15 minutes.
        </p>
      </div>
    );
  }

  if (status.state === "connected") {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Lead research runs on your ChatGPT subscription
          {status.accountId ? ` (account …${status.accountId.slice(-6)})` : ""}, model{" "}
          <span className="font-mono">{status.model}</span>. It does not fall back to Anthropic credit.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={test} disabled={busy} className="btn-secondary btn-sm">
            {busy ? "Testing…" : "Test with a web search"}
          </button>
          <button type="button" onClick={disconnect} disabled={busy} className="btn-ghost btn-sm text-destructive">
            Disconnect
          </button>
        </div>
        {testResult && (
          <p className={testResult.ok ? "text-xs text-emerald-400" : "text-xs text-destructive"}>
            {testResult.ok ? "✓ Working: " : "✗ "}
            {testResult.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <button type="button" onClick={connect} disabled={busy} className="btn-primary">
      {busy ? "Starting…" : "Connect ChatGPT"}
    </button>
  );
}
