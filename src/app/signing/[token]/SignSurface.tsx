"use client";

import { useRef, useState, useEffect } from "react";

type Field = { id: string; kind: string; label: string; required: boolean };

function todayISO() {
  // set once on mount to avoid SSR/client drift
  return new Date().toISOString().slice(0, 10);
}

/** Canvas signature pad — pointer drawing, exports a PNG data URL. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.strokeStyle = "#0f172a";
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent) => { drawing.current = true; const p = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.beginPath(); ctx.moveTo(p.x, p.y); ref.current!.setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const p = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; };
  const up = () => { if (!drawing.current) return; drawing.current = false; if (dirty.current) onChange(ref.current!.toDataURL("image/png")); };
  const clear = () => { const c = ref.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); dirty.current = false; onChange(null); };

  return (
    <div>
      <canvas ref={ref} width={460} height={150} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
        style={{ width: "100%", maxWidth: 460, height: 150, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, touchAction: "none", cursor: "crosshair" }} />
      <button type="button" onClick={clear} style={{ marginTop: 4, fontSize: 12, color: "#64748b", background: "none", border: "none", cursor: "pointer" }}>Clear</button>
    </div>
  );
}

export function SignSurface({ token, title, recipientName, docHtml, fields }: { token: string; title: string; recipientName: string; docHtml: string; fields: Field[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState(recipientName);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"signed" | "declined" | null>(null);

  const set = (id: string, val: string) => setValues((v) => ({ ...v, [id]: val }));

  const submit = async () => {
    setErr(null);
    if (name.trim().length < 2) return setErr("Please type your full name.");
    if (!consent) return setErr("Please tick the consent box to sign electronically.");
    // default any empty date fields to today at submit time (avoids SSR/client drift)
    const vals = { ...values };
    for (const f of fields) if (f.kind === "date" && !vals[f.id]) vals[f.id] = todayISO();
    for (const f of fields) {
      if (f.required && f.kind !== "checkbox" && !vals[f.id]) return setErr(`Please complete: ${f.label || f.kind}`);
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/signing/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), consent, fields: fields.map((f) => ({ id: f.id, value: vals[f.id] ?? (f.kind === "checkbox" ? "false" : "") })) }),
      });
      if (!res.ok) throw new Error(await res.text());
      setDone("signed");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not submit. Please try again."); }
    finally { setBusy(false); }
  };

  const decline = async () => {
    const reason = prompt("Optional: why are you declining?") ?? "";
    setBusy(true);
    try {
      const res = await fetch(`/api/signing/${token}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      if (!res.ok) throw new Error(await res.text());
      setDone("declined");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not decline."); }
    finally { setBusy(false); }
  };

  if (done === "signed") return <Card><h2 style={h2}>Signed ✓</h2><p style={p}>Thank you, {name}. Once everyone has signed, the completed sealed PDF will be emailed to you.</p></Card>;
  if (done === "declined") return <Card><h2 style={h2}>Declined</h2><p style={p}>You have declined this document. Denago has been notified.</p></Card>;

  return (
    <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>Please review the document, then complete your fields below.</div>
      </div>

      <iframe title="Document" srcDoc={docHtml} style={{ width: "100%", height: 620, border: "1px solid #334155", borderRadius: 10, background: "#fff" }} />

      <Card>
        <h2 style={h2}>Complete &amp; sign</h2>
        {fields.length === 0 && <p style={p}>No fields assigned to you — sign below to accept.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {fields.map((f) => (
            <div key={f.id}>
              <label style={label}>{f.label || cap(f.kind)}{f.required ? " *" : ""}</label>
              {f.kind === "signature" || f.kind === "initials" || f.kind === "stamp" ? (
                <SignaturePad onChange={(d) => set(f.id, d ?? "")} />
              ) : f.kind === "checkbox" ? (
                <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#e2e8f0", fontSize: 14 }}>
                  <input type="checkbox" checked={values[f.id] === "true"} onChange={(e) => set(f.id, e.target.checked ? "true" : "false")} /> {f.label || "I agree"}
                </label>
              ) : f.kind === "date" ? (
                <input type="date" value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} style={input} />
              ) : (
                <input type="text" value={values[f.id] ?? ""} placeholder={f.label} onChange={(e) => set(f.id, e.target.value)} style={input} />
              )}
            </div>
          ))}

          <div>
            <label style={label}>Your full name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={input} />
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: "#cbd5e1" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 2 }} />
            <span>I agree to sign this document electronically. My electronic signature is legally binding under the Electronic Communications and Transactions Act 25 of 2002 (South Africa).</span>
          </label>

          {err && <div style={{ color: "#fca5a5", fontSize: 13 }}>⚠ {err}</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" disabled={busy} onClick={submit} style={{ flex: 1, minWidth: 180, background: "#ea580c", color: "#fff", border: "none", borderRadius: 8, padding: "12px 20px", fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Submitting…" : "Sign & submit"}
            </button>
            <button type="button" disabled={busy} onClick={decline} style={{ background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "12px 16px", cursor: "pointer" }}>
              Decline
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "#fff", margin: "0 0 10px" };
const p: React.CSSProperties = { fontSize: 14, color: "#94a3b8", margin: 0 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 5 };
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 14, borderRadius: 8, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", boxSizing: "border-box" };
function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ width: "100%", maxWidth: 900, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 22 }}>{children}</div>;
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
