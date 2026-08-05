"use client";

import { useState, type ReactNode } from "react";
import type { IdentityStatus } from "@/lib/signing/identity";

type Result = { ok: boolean; status?: IdentityStatus; error?: string };

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
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status.required || status.verified) return <>{children}</>;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/signing/${token}/identity/start`, { method: "POST" });
      const result = (await response.json()) as Result;
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not send a verification code.");
      if (result.status) setStatus(result.status);
      setSent(true);
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

  return (
    <div style={{ width: "100%", maxWidth: 520, background: "#1e293b", border: "1px solid #334155", borderRadius: 14, padding: 24 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 8 }}>Verify your identity</div>
      <p style={{ color: "#cbd5e1", lineHeight: 1.55, marginTop: 0 }}>
        This document requires an additional identity check before it can be signed.
        {status.emailHint ? ` We’ll send a six-digit code to ${status.emailHint}.` : ""}
      </p>

      {!sent ? (
        <button type="button" onClick={start} disabled={busy}
          style={{ width: "100%", background: "#ea580c", color: "#fff", border: 0, borderRadius: 9, padding: "12px 16px", fontWeight: 800, cursor: busy ? "wait" : "pointer" }}>
          {busy ? "Sending…" : "Send verification code"}
        </button>
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
            style={{ width: "100%", background: "#ea580c", color: "#fff", border: 0, borderRadius: 9, padding: "12px 16px", fontWeight: 800, opacity: busy || code.length !== 6 ? .55 : 1, cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Verifying…" : "Verify and continue"}
          </button>
          <button type="button" onClick={start} disabled={busy}
            style={{ background: "transparent", color: "#94a3b8", border: 0, cursor: "pointer" }}>
            Send a new code
          </button>
        </div>
      )}

      {error ? <div role="alert" style={{ marginTop: 12, color: "#fca5a5", fontSize: 13 }}>{error}</div> : null}
      <div style={{ marginTop: 16, color: "#64748b", fontSize: 12, lineHeight: 1.5 }}>
        Verification codes expire after 10 minutes and are never stored in readable form.
      </div>
    </div>
  );
}
