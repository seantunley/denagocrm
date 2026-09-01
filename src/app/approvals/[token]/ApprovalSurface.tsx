"use client";

import { useState } from "react";

export function ApprovalSurface({ token, title, label, assignee, docHtml }: { token: string; title: string; label: string; assignee: string; docHtml: string }) {
  const [name, setName] = useState(assignee);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);

  async function act(decision: "approve" | "reject") {
    setErr(null);
    if (decision === "reject" && !rejecting) { setRejecting(true); return; }
    setBusy(decision);
    try {
      const res = await fetch(`/api/approvals/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, name: name.trim(), reason: reason.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      setDone(decision === "approve" ? "approved" : "rejected");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not submit."); }
    finally { setBusy(null); }
  }

  if (done === "approved") return <Card><h2 style={h2}>Approved ✓</h2><p style={p}>Thank you, {name}. The document moves to the next step.</p></Card>;
  if (done === "rejected") return <Card><h2 style={h2}>Rejected</h2><p style={p}>Thank you. The sender has been notified{reason ? ` with your reason` : ""}.</p></Card>;

  return (
    <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>Your approval is needed: <strong>{label}</strong>. Review the document, then approve or reject.</div>
      </div>

      {/* Sandboxed: this page is reached with a token by someone OUTSIDE the
          business, and the document it renders was composed inside it. Without
          `sandbox` a srcDoc iframe executes in this origin — so document content
          would run script on the page carrying the approver's token. Empty
          value: no scripts, no forms, no same-origin. The document is read
          here, never interacted with, so nothing is given up by that. */}
      <iframe title="Document" sandbox="" srcDoc={docHtml} style={{ width: "100%", height: 560, border: "1px solid #334155", borderRadius: 10, background: "#fff" }} />

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={label_}>Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={input} placeholder="Your name" />
          </div>
          {rejecting && (
            <div>
              <label style={label_}>Reason for rejection</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} style={{ ...input, resize: "vertical" }} placeholder="e.g. discount too high — re-quote at 10%" />
            </div>
          )}
          {err && <div style={{ color: "#fca5a5", fontSize: 13 }}>⚠ {err}</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" disabled={busy !== null} onClick={() => act("approve")}
              style={{ flex: 1, minWidth: 160, background: "#059669", color: "#fff", border: "none", borderRadius: 8, padding: "12px 20px", fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
              {busy === "approve" ? "Approving…" : "✓ Approve"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => act("reject")}
              style={{ flex: 1, minWidth: 160, background: rejecting ? "#e11d48" : "transparent", color: rejecting ? "#fff" : "#fca5a5", border: "1px solid #e11d48", borderRadius: 8, padding: "12px 20px", fontWeight: 700, cursor: "pointer" }}>
              {busy === "reject" ? "Rejecting…" : rejecting ? "Confirm reject" : "✗ Reject"}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "#fff", margin: "0 0 10px" };
const p: React.CSSProperties = { fontSize: 14, color: "#94a3b8", margin: 0 };
const label_: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 5 };
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 14, borderRadius: 8, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", boxSizing: "border-box" };
function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ width: "100%", maxWidth: 900, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 22 }}>{children}</div>;
}
