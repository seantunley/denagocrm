"use client";
import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";

export function PasskeyIdentityGate({ token }: { token: string }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function verify() {
    setBusy(true); setError(null);
    try {
      const optionResponse = await fetch(`/api/signing/${token}/identity/passkey/options`, { method: "POST" });
      if (!optionResponse.ok) throw new Error(await optionResponse.text());
      const options = await optionResponse.json();
      const response = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch(`/api/signing/${token}/identity/passkey/verify`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }),
      });
      if (!verifyResponse.ok) throw new Error(await verifyResponse.text());
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Passkey verification failed"); }
    finally { setBusy(false); }
  }
  return <div style={{ width: "100%", maxWidth: 460, background: "#1e293b", border: "1px solid #334155", borderRadius: 14, padding: 28 }}>
    <div style={{ fontSize: 20, fontWeight: 800, color: "#fff" }}>Verify with your passkey</div>
    <p style={{ color: "#94a3b8", lineHeight: 1.6 }}>Use the biometric or security key registered to the intended signer account. User verification is mandatory.</p>
    <button disabled={busy} onClick={verify} style={{ width: "100%", border: 0, borderRadius: 8, padding: "12px 16px", background: "#ea580c", color: "#fff", fontWeight: 800 }}>{busy ? "Verifying…" : "Use passkey"}</button>
    {error ? <p style={{ color: "#fca5a5", fontSize: 13 }}>{error}</p> : null}
  </div>;
}
