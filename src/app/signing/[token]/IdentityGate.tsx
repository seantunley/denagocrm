"use client";

import { useState, type ReactNode } from "react";
import type { IdentityStatus, IdentityChannel } from "@/lib/signing/identity";

type Result = { ok: boolean; status?: IdentityStatus; error?: string };

/**
 * The step a signer meets before a protected document opens.
 *
 * The signer picks a channel only from the list the server produced — the page
 * never names an address or a number, and the request carries only "email" or
 * "sms". Where the code goes is decided entirely from the recipient row, so a
 * link that fell into the wrong hands cannot have the code redirected to them.
 *
 * Only the masked hint is shown. It is enough for the signer to recognise which
 * of their own accounts is meant, and not enough for someone else holding the
 * link to learn the customer's email address or mobile number.
 */
export function IdentityGate({
  token,
  initial,
  children,
}: {
  token: string;
  initial: IdentityStatus;
  children: ReactNode;
}) {
  const [status, setStatus] = useState(initial);
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<IdentityChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status.required || status.verified) return <>{children}</>;

  // No channel means no address AND no number on file for this signer. Offering
  // a button that cannot work would strand them on a dead end with no
  // explanation, so say what is wrong and who can fix it.
  if (status.channels.length === 0) {
    return (
      <div style={panel}>
        <div style={heading}>Verify your identity</div>
        <p style={{ color: "#cbd5e1", lineHeight: 1.55, marginTop: 0 }}>
          This document needs an identity check, but we have no contact details on file to send a
          code to. Please reply to the message that brought you here so the sender can add them.
        </p>
      </div>
    );
  }

  const start = async (channel: IdentityChannel) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/signing/${token}/identity/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      const result = (await response.json()) as Result;
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not send a verification code.");
      if (result.status) setStatus(result.status);
      setSentTo(channel);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send a verification code.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/signing/${token}/identity/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = (await response.json()) as Result;
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not verify your identity.");
      setStatus(result.status ?? { ...status, verified: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not verify your identity.");
    } finally {
      setBusy(false);
    }
  };

  const label = (channel: IdentityChannel) => (channel === "sms" ? "Text me a code" : "Email me a code");
  const sentHint = status.channels.find((c) => c.channel === sentTo)?.hint;

  return (
    <div style={panel}>
      <div style={heading}>Verify your identity</div>
      <p style={{ color: "#cbd5e1", lineHeight: 1.55, marginTop: 0 }}>
        {sentTo
          ? `We’ve sent a six-digit code to ${sentHint}. It expires in 10 minutes.`
          : "This document asks you to confirm it’s really you before signing. Choose where to receive a six-digit code."}
      </p>

      {!sentTo ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {status.channels.map((option) => (
            <button
              key={option.channel}
              type="button"
              onClick={() => start(option.channel)}
              disabled={busy}
              style={{ ...primaryButton, cursor: busy ? "wait" : "pointer" }}
            >
              {busy ? "Sending…" : `${label(option.channel)} · ${option.hint}`}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label style={{ color: "#cbd5e1", fontSize: 13, fontWeight: 700 }}>
            Six-digit code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              maxLength={6}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={(event) => { if (event.key === "Enter" && code.length === 6 && !busy) void verify(); }}
              style={{ width: "100%", boxSizing: "border-box", marginTop: 7, background: "#0f172a", color: "#fff", border: "1px solid #475569", borderRadius: 9, padding: "13px 14px", fontSize: 22, letterSpacing: 6, textAlign: "center" }}
            />
          </label>
          <button type="button" onClick={verify} disabled={busy || code.length !== 6}
            style={{ ...primaryButton, opacity: busy || code.length !== 6 ? .55 : 1, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Verifying…" : "Verify and continue"}
          </button>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
            <button type="button" onClick={() => start(sentTo)} disabled={busy} style={linkButton}>
              Send a new code
            </button>
            {/* The other channel stays reachable. The usual reason a signature
                stalls here is the chosen route no longer reaching the person —
                an old mailbox, a changed number — and making them start over is
                how that becomes a phone call to the sender. */}
            {status.channels
              .filter((option) => option.channel !== sentTo)
              .map((option) => (
                <button key={option.channel} type="button" onClick={() => start(option.channel)} disabled={busy} style={linkButton}>
                  {label(option.channel)} instead
                </button>
              ))}
          </div>
        </div>
      )}

      {error ? <div role="alert" style={{ marginTop: 12, color: "#fca5a5", fontSize: 13 }}>{error}</div> : null}
      <div style={{ marginTop: 16, color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>
        Codes expire after 10 minutes and are never stored in readable form.
      </div>
    </div>
  );
}

const panel = { width: "100%", maxWidth: 520, background: "#1e293b", border: "1px solid #334155", borderRadius: 14, padding: 24 } as const;
const heading = { fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 8 } as const;
const primaryButton = { width: "100%", background: "#ea580c", color: "#fff", border: 0, borderRadius: 9, padding: "12px 16px", fontWeight: 800 } as const;
const linkButton = { background: "transparent", color: "#94a3b8", border: 0, cursor: "pointer", fontSize: 13 } as const;
