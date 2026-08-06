"use client";

import { useMemo, useState } from "react";

type Method = "email" | "sms";

export function IdentityGate({ token, required, masked }: { token: string; required: Method[]; masked: Partial<Record<Method, string>> }) {
  const [verified, setVerified] = useState<Method[]>([]);
  const remaining = useMemo(() => required.filter((method) => !verified.includes(method)), [required, verified]);
  const [method, setMethod] = useState<Method>(remaining[0] || required[0] || "email");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send(selected = method) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/signing/${token}/identity`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "send", method: selected }),
      });
      if (!response.ok) throw new Error(await response.text());
      setMethod(selected); setSent(true); setCode("");
      setMessage(`A verification code was sent to ${masked[selected] || "your verified contact method"}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not send a verification code"); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/signing/${token}/identity`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verify", method, code }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json() as { complete: boolean; verifiedMethods: Method[] };
      if (result.complete) { window.location.reload(); return; }
      const nextVerified = result.verifiedMethods || [...verified, method];
      setVerified(nextVerified); setSent(false); setCode("");
      const next = required.find((candidate) => !nextVerified.includes(candidate));
      if (next) { setMethod(next); setMessage(`${method === "email" ? "Email" : "Mobile"} verified. Verify ${next === "email" ? "email" : "your mobile number"} as the second factor.`); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not verify the code"); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ width: "100%", maxWidth: 460, background: "#1e293b", border: "1px solid #334155", borderRadius: 14, padding: 28 }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>Verify your identity</div>
      <p style={{ color: "#94a3b8", lineHeight: 1.6 }}>This signing link is personal. Complete {required.length > 1 ? "both verification steps" : "verification"} before the document is displayed.</p>
      {!sent ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {remaining.map((candidate) => (
            <button key={candidate} disabled={busy} onClick={() => send(candidate)} style={button}>
              {busy ? "Sending…" : `Send code to ${candidate === "email" ? "email" : "mobile"} (${masked[candidate] || "verified contact"})`}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ color: "#cbd5e1", fontSize: 13 }}>Enter the code sent to {masked[method] || method}.</div>
          <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code" style={{ border: "1px solid #475569", borderRadius: 8, background: "#0f172a", color: "#fff", padding: "12px 14px", fontSize: 18, letterSpacing: 6 }} />
          <button disabled={busy || code.length !== 6} onClick={verify} style={button}>{busy ? "Verifying…" : "Verify code"}</button>
          <button disabled={busy} onClick={() => send(method)} style={{ ...button, background: "transparent", border: "1px solid #475569" }}>Send a new code</button>
        </div>
      )}
      {message ? <p style={{ color: /sent|verified/i.test(message) ? "#86efac" : "#fca5a5", fontSize: 13 }}>{message}</p> : null}
      <p style={{ color: "#64748b", fontSize: 12, marginTop: 18 }}>Codes expire after 10 minutes and lock after repeated failed attempts. Mobile codes are delivered by SMS to the verified number.</p>
    </div>
  );
}

const button: React.CSSProperties = { width: "100%", border: 0, borderRadius: 8, padding: "12px 16px", background: "#ea580c", color: "#fff", fontWeight: 800, cursor: "pointer" };
