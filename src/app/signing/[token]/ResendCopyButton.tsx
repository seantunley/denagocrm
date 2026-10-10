"use client";

import { useState } from "react";

/**
 * "Send my copy again" on a finished signing link.
 *
 * It names no address and takes none: the copy goes to the email already on file
 * for this signer, so a link that fell into the wrong hands cannot be used to
 * have a signed contract sent somewhere else.
 */
export function ResendCopyButton({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setState("busy");
    setError(null);
    try {
      const response = await fetch(`/api/signing/${token}/copy`, { method: "POST" });
      if (!response.ok) throw new Error((await response.text()) || "We could not send your copy just now.");
      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not send your copy just now.");
      setState("idle");
    }
  };

  if (state === "sent") {
    return <div role="status" style={{ marginTop: 16, fontSize: 14, color: "#4ade80" }}>Sent — please check your inbox.</div>;
  }
  return (
    <div style={{ marginTop: 16 }}>
      <button
        type="button"
        onClick={send}
        disabled={state === "busy"}
        style={{ background: "#ea580c", color: "#fff", border: 0, borderRadius: 9, padding: "11px 18px", fontWeight: 700, cursor: state === "busy" ? "wait" : "pointer", opacity: state === "busy" ? 0.6 : 1 }}
      >
        {state === "busy" ? "Sending…" : "Send my copy again"}
      </button>
      {error ? <div role="alert" style={{ marginTop: 10, fontSize: 13, color: "#fca5a5" }}>{error}</div> : null}
    </div>
  );
}
