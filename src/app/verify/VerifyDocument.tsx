"use client";

import { useRef, useState } from "react";
import type { DocumentVerdict } from "@/lib/signing/verifyVerdict";

/** Bigger than any signed contract; small enough to fingerprint in a phone's memory. */
const MAX_BYTES = 100 * 1024 * 1024;

type State =
  | { step: "idle" }
  | { step: "checking"; name: string }
  | { step: "done"; name: string; sha256: string; verdict: DocumentVerdict }
  | { step: "error"; message: string };

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The file is fingerprinted HERE, in the browser, and only the fingerprint is
 * sent. Somebody checking a contract should not have to upload the contract to
 * do it, and the page says so because it is true.
 */
export function VerifyDocument() {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ step: "idle" });
  const [over, setOver] = useState(false);

  async function check(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setState({ step: "error", message: "That file is too large to be a signed document from here." });
      return;
    }
    setState({ step: "checking", name: file.name });
    try {
      const sha256 = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256 }),
      });
      if (res.status === 429) {
        setState({ step: "error", message: "Too many checks from this connection. Wait a few minutes and try again." });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setState({ step: "done", name: file.name, sha256, verdict: (await res.json()) as DocumentVerdict });
    } catch {
      setState({ step: "error", message: "The check could not be completed. Check your connection and try again." });
    }
  }

  const card: React.CSSProperties = { width: "100%", maxWidth: 520, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28 };
  const muted: React.CSSProperties = { fontSize: 14, color: "#94a3b8", lineHeight: 1.55 };

  return (
    <div style={card}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: "#fff", margin: "0 0 8px" }}>Check a signed document</h1>
      <p style={{ ...muted, margin: "0 0 18px" }}>
        Choose the signed PDF you were sent. We compare it with the record made when it was signed and tell you whether it is the
        genuine, unchanged document.
      </p>

      <button
        type="button"
        onClick={() => input.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => { event.preventDefault(); setOver(false); void check(event.dataTransfer.files[0]); }}
        disabled={state.step === "checking"}
        style={{
          width: "100%", padding: "26px 16px", borderRadius: 10, cursor: state.step === "checking" ? "wait" : "pointer",
          border: `2px dashed ${over ? "#f97316" : "#475569"}`, background: over ? "rgba(249,115,22,0.08)" : "#0f172a",
          color: "#e2e8f0", fontSize: 15, fontWeight: 600,
        }}
      >
        {state.step === "checking" ? `Checking ${state.name}…` : "Choose the PDF, or drop it here"}
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => { void check(event.target.files?.[0]); event.target.value = ""; }}
      />
      <p style={{ fontSize: 12, color: "#64748b", margin: "10px 0 0" }}>
        The file stays on your device. Only its fingerprint — a short code worked out from the file — is sent.
      </p>

      <div aria-live="polite">
        {state.step === "error" && (
          <div role="alert" style={{ marginTop: 18, padding: 14, borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.4)", color: "#fecaca", fontSize: 14 }}>
            {state.message}
          </div>
        )}

        {state.step === "done" && state.verdict.genuine && (
          <div style={{ marginTop: 18, padding: 16, borderRadius: 10, background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.45)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#6ee7b7" }}>✓ Genuine and unchanged</div>
            <p style={{ fontSize: 14, color: "#d1fae5", margin: "8px 0 0", lineHeight: 1.55 }}>
              <strong>{state.name}</strong> is exactly the document that was sealed by <strong>{state.verdict.sealedBy}</strong> on{" "}
              {state.verdict.sealedAt} ({state.verdict.timeZone} time).
            </p>
            <ul style={{ fontSize: 13, color: "#a7f3d0", margin: "10px 0 0", paddingLeft: 18, lineHeight: 1.7 }}>
              <li>{state.verdict.title}</li>
              <li>Signed by {state.verdict.signers} {state.verdict.signers === 1 ? "person" : "people"} — their names are on the last page</li>
              <li>{state.verdict.timestamped ? "The time was confirmed by an independent time-stamp service" : "No independent time-stamp was recorded for it"}</li>
            </ul>
          </div>
        )}

        {state.step === "done" && !state.verdict.genuine && (
          <div style={{ marginTop: 18, padding: 16, borderRadius: 10, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.45)" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#fcd34d" }}>No match</div>
            <p style={{ fontSize: 14, color: "#fde68a", margin: "8px 0 0", lineHeight: 1.55 }}>
              <strong>{state.name}</strong> is not a document that was signed and sealed here, or it has been changed since.
            </p>
            <p style={{ fontSize: 13, color: "#fcd34d", margin: "8px 0 0", lineHeight: 1.55 }}>
              Any change breaks the match — including opening the PDF and saving it again, or printing it to a new PDF. If you
              expected this to be genuine, ask whoever sent it for the original file.
            </p>
          </div>
        )}

        {state.step === "done" && (
          <p style={{ fontSize: 11, color: "#64748b", margin: "12px 0 0", wordBreak: "break-all", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>
            Fingerprint (SHA-256): {state.sha256}
          </p>
        )}
      </div>
    </div>
  );
}
