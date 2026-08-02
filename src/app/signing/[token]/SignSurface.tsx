"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import type { StampField } from "@/lib/doceditor/serialize";
import { TextPromptDialog } from "@/components/TextPromptDialog";
import { isFieldValueComplete } from "@/lib/signing/fieldValidation";

type Field = { id: string; kind: string; label: string; required: boolean; page: number; x: number; y: number; width: number; height: number };
type Sheets = { width: number; height: number; margin: number; css: string; pages: string[] };

const ACCENT = "#2563eb";
const isSignatureKind = (k: string) => k === "signature" || k === "initials" || k === "stamp";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** An ISO date as a reader expects to see it on a signed document. */
function formatStamp(iso: string) {
  const parsed = new Date(`${iso}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
}

/** Canvas signature pad — pointer drawing, exports a PNG data URL. */
function SignaturePad({ onDone, onCancel }: { onDone: (dataUrl: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.strokeStyle = "#0f172a";
  }, []);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (ref.current!.width / r.width), y: (e.clientY - r.top) * (ref.current!.height / r.height) };
  };
  const down = (e: React.PointerEvent) => { drawing.current = true; const p = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.beginPath(); ctx.moveTo(p.x, p.y); ref.current!.setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const p = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; };
  const up = () => { drawing.current = false; };
  const clear = () => { const c = ref.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); dirty.current = false; };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }} onClick={onCancel}>
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 14, padding: 20, width: "100%", maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 10 }}>Draw your signature</div>
        <canvas ref={ref} width={480} height={180} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
          style={{ width: "100%", height: 180, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, touchAction: "none", cursor: "crosshair" }} />
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "space-between" }}>
          <button type="button" onClick={clear} style={{ fontSize: 13, color: "#94a3b8", background: "none", border: "none", cursor: "pointer" }}>Clear</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancel} style={{ background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>Cancel</button>
            <button type="button" onClick={() => { if (!dirty.current) return; onDone(ref.current!.toDataURL("image/png")); }}
              style={{ background: "#ea580c", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, cursor: "pointer" }}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One interactive field overlaid on the sheet at its placed coordinates. */
function FieldWidget({ f, value, onSign, onSet, filled }: { f: Field; value: string; onSign: () => void; onSet: (v: string) => void; filled: boolean }) {
  const box: React.CSSProperties = { position: "absolute", left: f.x, top: f.y, width: f.width, height: f.height };
  const ring = filled ? "#16a34a" : ACCENT;

  if (isSignatureKind(f.kind)) {
    return (
      <button type="button" onClick={onSign} title={f.label || "Sign"}
        style={{ ...box, border: `2px ${filled ? "solid" : "dashed"} ${ring}`, borderRadius: 6, background: filled ? "#fff" : "#2563eb14", cursor: "pointer", padding: 3, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {value
          ? <img src={value} alt="signature" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          : <span style={{ color: ACCENT, fontSize: 12, fontWeight: 700 }}>✍ {f.label || "Tap to sign"}</span>}
      </button>
    );
  }
  if (f.kind === "checkbox") {
    return (
      <label style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
        <input type="checkbox" checked={value === "true"} onChange={(e) => onSet(e.target.checked ? "true" : "false")} style={{ width: 20, height: 20, accentColor: ACCENT }} />
      </label>
    );
  }
  const common: React.CSSProperties = { ...box, border: `2px solid ${ring}`, borderRadius: 6, padding: "2px 6px", fontSize: 13, color: "#0f172a", background: "#fff", outline: "none" };
  if (f.kind === "date") {
    // Stamped, never typed. This is the date the signature was applied, so a
    // signer who could edit it could record a date they did not sign on — and
    // an empty box next to a signature reads as one more thing to fill in.
    return (
      <div style={{ ...common, display: "flex", alignItems: "center", background: "#f8fafc" }} title="Stamped when you sign">
        {formatStamp(value || todayISO())}
      </div>
    );
  }
  return <input type="text" placeholder={f.label} value={value} onChange={(e) => onSet(e.target.value)} style={common} />;
}

/** A read-only field already completed by an earlier signer (e.g. Denago's signature). */
function StampView({ s }: { s: StampField }) {
  const box: React.CSSProperties = { position: "absolute", left: s.x, top: s.y, width: s.width, height: s.height, pointerEvents: "none" };
  if ((s.kind === "signature" || s.kind === "initials" || s.kind === "stamp") && s.image) {
    return <div style={{ ...box, display: "flex", alignItems: "flex-end", justifyContent: "center" }}><img src={s.image} alt="signed" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>;
  }
  return <div style={{ ...box, display: "flex", alignItems: "flex-end", fontSize: 13, color: "#0f172a" }}>{s.text ?? ""}</div>;
}

export function SignSurface({ token, title, recipientName, sheets, fields, stamps = [] }: { token: string; title: string; recipientName: string; sheets: Sheets; fields: Field[]; stamps?: StampField[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState(recipientName);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"signed" | "declined" | null>(null);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const wrapRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);

  // Fit the A4 sheet to the available width (never upscale past 1).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, (el.clientWidth) / sheets.width));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheets.width]);

  const set = (id: string, val: string) => setValues((v) => ({ ...v, [id]: val }));

  const placed = fields.filter((f) => (f.x > 0 || f.y > 0) && f.x < sheets.width && f.y < sheets.height && f.page < sheets.pages.length);
  const unplaced = fields.filter((f) => !placed.includes(f));
  // isFieldValueComplete is the SAME kind-aware check the API uses
  // (missingRequiredForRecipient) — a checkbox only counts once actually
  // checked, so client and server can't drift on what "required" means.
  const isFilled = useCallback((f: Field) => isFieldValueComplete(f.kind, values[f.id]), [values]);
  const required = fields.filter((f) => f.required && f.kind !== "date");
  const doneCount = required.filter((f) => isFieldValueComplete(f.kind, values[f.id])).length;

  const submit = async () => {
    setErr(null);
    if (name.trim().length < 2) return setErr("Please type your full name.");
    if (!consent) return setErr("Please tick the consent box to sign electronically.");
    const vals = { ...values };
    for (const f of fields) if (f.kind === "date" && !vals[f.id]) vals[f.id] = todayISO();
    for (const f of fields) {
      if (f.kind === "checkbox" && !vals[f.id]) vals[f.id] = "false";
      if (f.required && !isFieldValueComplete(f.kind, vals[f.id])) {
        setErr(`Please complete: ${f.label || f.kind}`);
        return;
      }
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

  const decline = async (reason: string) => {
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
    <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 16, paddingBottom: 84 }}>
      <style dangerouslySetInnerHTML={{ __html: sheets.css }} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>Review the document, then tap the highlighted boxes to complete your fields.</div>
      </div>

      {/* Scaled A4 sheets with interactive fields overlaid at their exact positions */}
      <div ref={wrapRef} style={{ width: "100%" }}>
        {sheets.pages.map((pageHtml, i) => (
          <div key={i} style={{ width: sheets.width * scale, height: sheets.height * scale, position: "relative", margin: "0 auto 16px", boxShadow: "0 6px 24px rgba(0,0,0,.35)", background: "#fff" }}>
            <div style={{ width: sheets.width, height: sheets.height, transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute", top: 0, left: 0 }}>
              <div className="sg-sheet" style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: pageHtml }} />
              {stamps.filter((s) => s.page === i).map((s, si) => <StampView key={`s${si}`} s={s} />)}
              {placed.filter((f) => f.page === i).map((f) => (
                <FieldWidget key={f.id} f={f} value={values[f.id] ?? ""} filled={isFilled(f)}
                  onSign={() => setSigningId(f.id)} onSet={(v) => set(f.id, v)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Any fields that weren't placed on the page still get completed here */}
      {unplaced.length > 0 && (
        <Card>
          <h2 style={h2}>Additional fields</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {unplaced.map((f) => (
              <div key={f.id}>
                <label style={label}>{f.label || cap(f.kind)}{f.required ? " *" : ""}</label>
                {isSignatureKind(f.kind) ? (
                  <button type="button" onClick={() => setSigningId(f.id)} style={{ ...input, textAlign: "left", cursor: "pointer", height: 48, display: "flex", alignItems: "center" }}>
                    {values[f.id] ? <img src={values[f.id]} alt="signature" style={{ height: 36 }} /> : <span style={{ color: "#94a3b8" }}>✍ Tap to sign</span>}
                  </button>
                ) : f.kind === "checkbox" ? (
                  <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#e2e8f0", fontSize: 14 }}>
                    <input type="checkbox" checked={values[f.id] === "true"} onChange={(e) => set(f.id, e.target.checked ? "true" : "false")} /> {f.label || "I agree"}
                  </label>
                ) : f.kind === "date" ? (
                  <div style={{ ...input, color: "#94a3b8" }}>{formatStamp(values[f.id] || todayISO())} · stamped when you sign</div>
                ) : (
                  <input type="text" value={values[f.id] ?? ""} placeholder={f.label} onChange={(e) => set(f.id, e.target.value)} style={input} />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Identity + consent + submit */}
      <Card>
        <div ref={actionRef} />
        <h2 style={h2}>Confirm &amp; sign</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
            <TextPromptDialog
              title="Decline this document?"
              description="You can add an optional reason. Denago will be notified and the request can no longer be signed by you."
              label="Reason (optional)"
              placeholder="Tell us what needs attention"
              required={false}
              submitLabel="Decline document"
              onSubmit={decline}
              trigger={<button type="button" disabled={busy} style={{ background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "12px 16px", cursor: "pointer" }}>Decline</button>}
            />
          </div>
        </div>
      </Card>

      {/* Sticky progress bar */}
      {required.length > 0 && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "#1e293b", borderTop: "1px solid #334155", padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "center", gap: 14, zIndex: 30 }}>
          <span style={{ fontSize: 13, color: doneCount >= required.length ? "#4ade80" : "#94a3b8" }}>
            {doneCount >= required.length ? "✓ All fields complete" : `${doneCount} of ${required.length} required fields complete`}
          </span>
          <button type="button" onClick={() => actionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
            style={{ background: ACCENT, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 700, cursor: "pointer", fontSize: 13 }}>
            Go to sign →
          </button>
        </div>
      )}

      {signingId && (
        <SignaturePad onCancel={() => setSigningId(null)} onDone={(url) => { set(signingId, url); setSigningId(null); }} />
      )}
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
