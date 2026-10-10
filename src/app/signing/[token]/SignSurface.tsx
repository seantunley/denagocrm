"use client";

import { useRef, useState, useEffect, useLayoutEffect, useCallback } from "react";
import type { StampField } from "@/lib/doceditor/serialize";
import { TextPromptDialog } from "@/components/TextPromptDialog";
import { isFieldValueComplete } from "@/lib/signing/fieldValidation";
import { SIGNING_CONSENT } from "@/lib/signing/consent";
import { signatureFont } from "./signatureFont";

/**
 * Set when the signer is using a member of staff's device, in front of them.
 * `pass` is that member of staff vouching for who is signing (it stands in for
 * the one-time code); the rest is where the device goes afterwards.
 */
export type InPersonSigning = { pass: string; staffName: string; doneHref: string };

type Field = { id: string; kind: string; label: string; required: boolean; page: number; x: number; y: number; width: number; height: number };
type Sheets = { width: number; height: number; margin: number; css: string; pages: string[] };
/** How a signature image was made. Sent with it, and recorded in the evidence. */
type SignatureMethod = "drawn" | "typed";

const ACCENT = "#2563eb";
const isSignatureKind = (k: string) => k === "signature" || k === "initials" || k === "stamp";

/**
 * How far the page can be enlarged, as a multiple of "fits the screen".
 *
 * An A4 sheet fitted to a phone is under half size: a 13px line of a quote is
 * about 6px tall, which nobody can read and which is the size people were being
 * asked to sign at. Twice that is roughly print size on a phone; three times is
 * for small print and tired eyes.
 */
const ZOOMS = [1, 1.5, 2, 3];

/** The few rules that inline styles cannot express: a keyframe, and the narrow-screen bar. */
const SURFACE_CSS = `
@keyframes sg-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } 50% { box-shadow: 0 0 0 9px rgba(37,99,235,.4); } }
.sg-pulse { animation: sg-pulse .8s ease-in-out 3; }
.sg-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 10px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px)); background: #1e293b; border-top: 1px solid #334155; }
.sg-bar button { white-space: nowrap; }
@media (max-width: 520px) { .sg-bar-progress { flex: 1 1 100%; text-align: center; } .sg-bar button { flex: 1 1 0; } }
`;

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

/**
 * A typed name as a signature image.
 *
 * It comes out as the same kind of PNG a drawn signature does, so the route, the
 * stored file and the sealed PDF treat the two identically — the only difference
 * that reaches the server is the word "typed" beside it.
 */
async function typedSignaturePng(text: string): Promise<string> {
  const SIZE = 150;
  const family = signatureFont.style.fontFamily;
  const font = `600 ${SIZE}px ${family}`;
  // The face is only fetched on first use. Drawing before it has arrived would
  // set the name in whatever the browser fell back to.
  await document.fonts.load(font, text).catch(() => {});
  const canvas = document.createElement("canvas");
  const measure = canvas.getContext("2d")!;
  measure.font = font;
  // The image is cut to the name, with a little air round it. A fixed canvas
  // left a short name floating in white space, and the signature line then
  // showed it at a fraction of the size a drawn one gets.
  canvas.width = Math.min(3600, Math.ceil(measure.measureText(text).width) + 80);
  canvas.height = Math.round(SIZE * 1.5);
  const ctx = canvas.getContext("2d")!; // resizing a canvas resets its context
  ctx.font = font;
  ctx.fillStyle = "#0f172a";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 40);
  return canvas.toDataURL("image/png");
}

/**
 * Where a signature is made: drawn on a canvas, or typed and set in a script
 * face. Either way it exports a PNG data URL.
 *
 * Typing exists because drawing with a thumb on a phone produces a scrawl people
 * are embarrassed to put on a contract — and some cannot draw one at all.
 */
function SignaturePad({ what, suggestion, onDone, onCancel }: { what: "signature" | "initials"; suggestion: string; onDone: (dataUrl: string, method: SignatureMethod) => void; onCancel: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState(suggestion);
  const [working, setWorking] = useState(false);

  // The canvas is a new element each time Draw is shown, so its pen is set then.
  useEffect(() => {
    if (mode !== "draw") return;
    const ctx = ref.current!.getContext("2d")!;
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.strokeStyle = "#0f172a";
    dirty.current = false;
  }, [mode]);

  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (ref.current!.width / r.width), y: (e.clientY - r.top) * (ref.current!.height / r.height) };
  };
  const down = (e: React.PointerEvent) => { drawing.current = true; const p = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.beginPath(); ctx.moveTo(p.x, p.y); ref.current!.setPointerCapture(e.pointerId); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const p = pos(e); const ctx = ref.current!.getContext("2d")!; ctx.lineTo(p.x, p.y); ctx.stroke(); dirty.current = true; };
  const up = () => { drawing.current = false; };
  const clear = () => { const c = ref.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); dirty.current = false; };

  const apply = async () => {
    if (mode === "draw") {
      if (dirty.current) onDone(ref.current!.toDataURL("image/png"), "drawn");
      return;
    }
    const text = typed.trim();
    if (!text || working) return;
    setWorking(true);
    try { onDone(await typedSignaturePng(text), "typed"); } finally { setWorking(false); }
  };

  const tab = (value: "draw" | "type", text: string) => (
    <button type="button" role="tab" aria-selected={mode === value} onClick={() => setMode(value)}
      style={{ flex: 1, padding: "8px 12px", fontSize: 13, fontWeight: 700, borderRadius: 7, border: "none", cursor: "pointer", background: mode === value ? "#0f172a" : "transparent", color: mode === value ? "#fff" : "#94a3b8" }}>
      {text}
    </button>
  );

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }} onClick={onCancel}>
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 14, padding: 20, width: "100%", maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 10 }}>{mode === "draw" ? "Draw" : "Type"} your {what}</div>
        <div role="tablist" style={{ display: "flex", gap: 4, padding: 4, marginBottom: 12, background: "#334155", borderRadius: 10 }}>
          {tab("draw", "Draw")}
          {tab("type", "Type")}
        </div>
        {mode === "draw" ? (
          <canvas ref={ref} width={480} height={180} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
            style={{ width: "100%", height: 180, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, touchAction: "none", cursor: "crosshair" }} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={typed} maxLength={60} autoFocus onChange={(e) => setTyped(e.target.value)} placeholder={what === "initials" ? "Your initials" : "Your full name"}
              onKeyDown={(e) => { if (e.key === "Enter") void apply(); }} style={input} aria-label={what === "initials" ? "Your initials" : "Your full name"} />
            <div aria-hidden style={{ height: 110, background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: "0 12px", color: "#0f172a", fontFamily: signatureFont.style.fontFamily, fontWeight: 600, fontSize: typed.trim().length > 22 ? 30 : 44, whiteSpace: "nowrap" }}>
              {typed.trim() || " "}
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "space-between" }}>
          {mode === "draw"
            ? <button type="button" onClick={clear} style={{ fontSize: 13, color: "#94a3b8", background: "none", border: "none", cursor: "pointer" }}>Clear</button>
            : <span />}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onCancel} style={{ background: "transparent", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "9px 14px", cursor: "pointer" }}>Cancel</button>
            <button type="button" onClick={() => void apply()} disabled={working}
              style={{ background: "#ea580c", color: "#fff", border: "none", borderRadius: 8, padding: "9px 18px", fontWeight: 700, cursor: "pointer" }}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One interactive field overlaid on the sheet at its placed coordinates. */
function FieldWidget({ f, value, onSign, onSet, filled, pulse }: { f: Field; value: string; onSign: () => void; onSet: (v: string) => void; filled: boolean; pulse: boolean }) {
  // border-box explicitly, not by the global reset: the 2px border and padding of
  // a live control must stay INSIDE the field's rect, or the control grows past
  // the line it is placed on.
  const box: React.CSSProperties = { position: "absolute", left: f.x, top: f.y, width: f.width, height: f.height, boxSizing: "border-box", margin: 0 };
  const ring = filled ? "#16a34a" : ACCENT;
  // What "Next" scrolls to, and briefly rings so the eye lands on it.
  const target = { id: `sg-field-${f.id}`, className: pulse ? "sg-pulse" : undefined };

  if (isSignatureKind(f.kind)) {
    return (
      <button type="button" {...target} onClick={onSign} title={f.label || "Sign"}
        style={{ ...box, border: `2px ${filled ? "solid" : "dashed"} ${ring}`, borderRadius: 6, background: filled ? "#fff" : "#2563eb14", cursor: "pointer", padding: 3, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {value
          ? <img src={value} alt="signature" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          : <span style={{ color: ACCENT, fontSize: 12, fontWeight: 700 }}>✍ {f.label || "Tap to sign"}</span>}
      </button>
    );
  }
  if (f.kind === "checkbox") {
    return (
      <label {...target} style={{ ...box, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
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
  return <input type="text" {...target} placeholder={f.label} value={value} onChange={(e) => onSet(e.target.value)} style={common} />;
}

/** A read-only field already completed by an earlier signer (e.g. Denago's signature). */
function StampView({ s }: { s: StampField }) {
  const box: React.CSSProperties = { position: "absolute", left: s.x, top: s.y, width: s.width, height: s.height, pointerEvents: "none" };
  if ((s.kind === "signature" || s.kind === "initials" || s.kind === "stamp") && s.image) {
    return <div style={{ ...box, display: "flex", alignItems: "flex-end", justifyContent: "center" }}><img src={s.image} alt="signed" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>;
  }
  return <div style={{ ...box, display: "flex", alignItems: "flex-end", fontSize: 13, color: "#0f172a" }}>{s.text ?? ""}</div>;
}

/**
 * The signed copy, offered to the person who just signed.
 *
 * Their signature is saved before the document is sealed, so the copy does not
 * exist yet when this first shows. It asks a few times over three-quarters of a
 * minute and offers the button only once it will work; if others still have to
 * sign, or it is taking long, it says nothing and the sentence above — the copy
 * arrives by email — stands on its own. The server only answers this browser
 * (see lib/signing/signedCopyPass.ts).
 */
function SignedCopy({ token }: { token: string }) {
  const [state, setState] = useState<"checking" | "ready" | "later">("checking");

  useEffect(() => {
    const waits = [1500, 2500, 3500, 5000, 7000, 10000, 15000];
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (attempt: number) => {
      let answer: string | null = null;
      try {
        const res = await fetch(`/api/signing/${token}/signed?check`, { cache: "no-store" });
        // Anything but "preparing" ends it: ready, others still to sign, or no pass.
        answer = res.ok ? ((await res.json()) as { state?: string }).state ?? "later" : "later";
      } catch { /* a dropped connection is worth another try */ }
      if (stopped) return;
      if (answer === "ready") return setState("ready");
      if ((answer && answer !== "preparing") || attempt >= waits.length) return setState("later");
      timer = setTimeout(() => void ask(attempt + 1), waits[attempt]);
    };
    timer = setTimeout(() => void ask(0), 1200);
    return () => { stopped = true; clearTimeout(timer); };
  }, [token]);

  if (state === "later") return null;
  if (state === "checking") return <p style={{ ...p, marginTop: 14 }}>Preparing your signed copy…</p>;
  return (
    <div style={{ marginTop: 16 }}>
      <a href={`/api/signing/${token}/signed`} style={{ display: "inline-block", background: "#ea580c", color: "#fff", borderRadius: 8, padding: "11px 18px", fontWeight: 700, textDecoration: "none" }}>
        ⬇ Download your signed copy
      </a>
      <p style={{ ...p, fontSize: 12.5, marginTop: 8 }}>Available on this device for the next few minutes.</p>
    </div>
  );
}

export function SignSurface({ token, title, recipientName, sheets, fields, stamps = [], senderName, inPerson }: { token: string; title: string; recipientName: string; sheets: Sheets; fields: Field[]; stamps?: StampField[]; senderName?: string; inPerson?: InPersonSigning }) {
  // The company that sent this document, for the two places the copy names them.
  // Undefined keeps the original literal — see tests/customerBranding.test.ts.
  const sender = senderName ?? "The sender";
  const senderInline = sender === "The sender" ? "the sender" : sender;
  const [values, setValues] = useState<Record<string, string>>({});
  const [methods, setMethods] = useState<Record<string, SignatureMethod>>({});
  const [name, setName] = useState(recipientName);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<"signed" | "declined" | null>(null);
  const [asked, setAsked] = useState(false);
  const [signingId, setSigningId] = useState<string | null>(null);
  const [pulse, setPulse] = useState<string | null>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);
  // Everything below is laid out at this one scale: "fits the screen", times
  // whatever the reader has zoomed to.
  const scale = fit * zoom;

  const wrapRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  /** How far down the document the reader was (0–1) when they changed the zoom. */
  const readingAt = useRef<number | null>(null);

  // Fit the A4 sheet to the available width (never upscale past 1).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fitNow = () => setFit(Math.min(1, (el.clientWidth) / sheets.width));
    fitNow();
    const ro = new ResizeObserver(fitNow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheets.width]);

  // Zooming changes the height of every page, so the same scroll offset is a
  // different place in the document. Put the reader back where they were.
  const zoomTo = (next: number) => {
    const el = wrapRef.current;
    if (el && el.offsetHeight > 0) {
      const top = el.getBoundingClientRect().top;
      readingAt.current = Math.min(1, Math.max(0, (window.innerHeight / 2 - top) / el.offsetHeight));
    }
    setZoom(next);
  };
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || readingAt.current === null) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: top + readingAt.current * el.offsetHeight - window.innerHeight / 2 });
    readingAt.current = null;
  }, [zoom]);

  useEffect(() => {
    if (!pulse) return;
    const timer = setTimeout(() => setPulse(null), 2600);
    return () => clearTimeout(timer);
  }, [pulse]);

  const set = (id: string, val: string) => setValues((v) => ({ ...v, [id]: val }));

  const placed = fields.filter((f) => (f.x > 0 || f.y > 0) && f.x < sheets.width && f.y < sheets.height && f.page < sheets.pages.length);
  const unplaced = fields.filter((f) => !placed.includes(f));
  // isFieldValueComplete is the SAME kind-aware check the API uses
  // (missingRequiredForRecipient) — a checkbox only counts once actually
  // checked, so client and server can't drift on what "required" means.
  const isFilled = useCallback((f: Field) => isFieldValueComplete(f.kind, values[f.id]), [values]);
  const required = fields.filter((f) => f.required && f.kind !== "date");
  const doneCount = required.filter((f) => isFieldValueComplete(f.kind, values[f.id])).length;
  // What is still to do, in the order a reader meets it: down each page, then
  // the fields that were never placed on one.
  const todo = [...placed]
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    .concat(unplaced)
    .filter((f) => f.required && f.kind !== "date" && !isFilled(f));

  // "Next" takes the signer to the next thing only they can do, and starts it
  // for them: the pad for a signature, the keyboard for a text box. When nothing
  // is left it goes to the consent and the Sign button.
  const goNext = () => {
    const next = todo[0];
    if (!next) {
      actionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setPulse(next.id);
    const el = document.getElementById(`sg-field-${next.id}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    if (isSignatureKind(next.kind)) window.setTimeout(() => setSigningId(next.id), 450);
    else if (el instanceof HTMLInputElement) el.focus({ preventScroll: true });
  };

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
        body: JSON.stringify({
          name: name.trim(),
          consent,
          // Which wording the box above was ticked against — recorded with the signature.
          consentVersion: SIGNING_CONSENT.version,
          ...(inPerson ? { inPerson: inPerson.pass } : {}),
          fields: fields.map((f) => ({
            id: f.id,
            value: vals[f.id] ?? (f.kind === "checkbox" ? "false" : ""),
            ...(isSignatureKind(f.kind) && methods[f.id] && vals[f.id] ? { method: methods[f.id] } : {}),
          })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setDone("signed");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not submit. Please try again."); }
    finally { setBusy(false); }
  };

  const decline = async (reason: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/signing/${token}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, ...(inPerson ? { inPerson: inPerson.pass } : {}) }) });
      if (!res.ok) throw new Error(await res.text());
      setDone("declined");
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not decline."); }
    finally { setBusy(false); }
  };

  // Throws on failure so the dialog stays open with the reason in it: a question
  // that silently went nowhere is worse than one the signer knows to send again.
  const ask = async (question: string) => {
    const res = await fetch(`/api/signing/${token}/question`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
    if (!res.ok) throw new Error((await res.text()) || "Could not send your question. Please try again.");
    // Confirmed in the bar and beside the Sign button, not in a toast: a toast
    // here would sit on top of the very buttons the signer needs next.
    setAsked(true);
  };

  // Declining is offered wherever signing is (Sean, 2026-10-08: "Send a quote to
  // sign that they can't decline is not good") — it used to be one quiet grey
  // button at the very bottom of the page, easy never to find.
  const declineDialog = (trigger: React.ReactElement) => (
    <TextPromptDialog
      title="Decline this document?"
      description={`Please tell us why, so we can put it right. ${sender} will be notified and the request can no longer be signed by you.`}
      label="Reason (optional)"
      placeholder="Tell us what needs attention"
      required={false}
      submitLabel="Decline document"
      onSubmit={decline}
      trigger={trigger}
    />
  );

  // The third answer. Until now a signer who was unsure about one line could
  // only sign anyway or decline the whole document; asking leaves it open.
  const questionDialog = (trigger: React.ReactElement) => (
    <TextPromptDialog
      title="Ask a question"
      description={`Your question goes straight to ${senderInline}. Nothing is signed or declined by asking — this page stays open for you.`}
      label="Your question"
      placeholder="What would you like to know?"
      submitLabel="Send question"
      onSubmit={ask}
      trigger={trigger}
    />
  );

  // On a member of staff's device the last screen also has to get the device
  // back to them — the customer is holding somebody else's signed-in CRM.
  const handBack = inPerson ? (
    <p style={{ ...p, marginTop: 14 }}>
      Please hand this device back to {inPerson.staffName}.{" "}
      <a href={inPerson.doneHref} style={{ color: "#94a3b8", textDecoration: "underline" }}>Staff: back to the request</a>
    </p>
  ) : null;
  if (done === "signed") return <Card><h2 style={h2}>Signed ✓</h2><p style={p}>Thank you, {name}. Once everyone has signed, the completed sealed PDF will be emailed to you.</p>{inPerson ? null : <SignedCopy token={token} />}{handBack}</Card>;
  if (done === "declined") return <Card><h2 style={h2}>Declined</h2><p style={p}>You have declined this document. {sender} has been notified.</p>{handBack}</Card>;

  const signingField = signingId ? fields.find((f) => f.id === signingId) : undefined;
  const initials = name.split(/\s+/).filter(Boolean).map((part) => part[0]!.toUpperCase()).join("");
  const barButton: React.CSSProperties = { borderRadius: 8, padding: "9px 14px", fontWeight: 600, cursor: "pointer", fontSize: 13 };
  const quiet: React.CSSProperties = { background: "transparent", color: "#e2e8f0", border: "1px solid #64748b" };

  return (
    <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", gap: 16, paddingBottom: 116 }}>
      <style dangerouslySetInnerHTML={{ __html: sheets.css }} />
      <style dangerouslySetInnerHTML={{ __html: SURFACE_CSS }} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{title}</div>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>Review the document, then tap the highlighted boxes to complete your fields.</div>
        {/* Not on a member of staff's device: it would save the customer's document to it. */}
        {!inPerson && (
          <a href={`/api/signing/${token}/document`} style={{ display: "inline-block", marginTop: 8, fontSize: 13, color: "#93c5fd" }}>⬇ Download a copy (PDF)</a>
        )}
      </div>

      {/* Only where the page has been shrunk to fit — on a wide screen it is already life-size. */}
      {(fit < 0.9 || zoom > 1) && (
        <div style={{ position: "sticky", top: 8, zIndex: 20, display: "flex", justifyContent: "flex-end", pointerEvents: "none", marginBottom: -8 }}>
          <div style={{ pointerEvents: "auto", display: "flex", alignItems: "center", gap: 2, background: "#1e293bf2", border: "1px solid #475569", borderRadius: 999, padding: 3, boxShadow: "0 4px 14px rgba(0,0,0,.35)" }}>
            <button type="button" aria-label="Zoom out" disabled={zoom === ZOOMS[0]} onClick={() => zoomTo(ZOOMS[ZOOMS.indexOf(zoom) - 1])} style={{ ...zoomButton, opacity: zoom === ZOOMS[0] ? 0.4 : 1 }}>−</button>
            <span style={{ fontSize: 12, color: "#cbd5e1", minWidth: 44, textAlign: "center" }}>{zoom === 1 ? "Zoom" : `${zoom}×`}</span>
            <button type="button" aria-label="Zoom in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => zoomTo(ZOOMS[ZOOMS.indexOf(zoom) + 1])} style={{ ...zoomButton, opacity: zoom === ZOOMS[ZOOMS.length - 1] ? 0.4 : 1 }}>+</button>
          </div>
        </div>
      )}

      {/* Scaled A4 sheets with interactive fields overlaid at their exact positions.
          Zoomed in, a sheet is wider than the screen and this scrolls sideways. */}
      <div ref={wrapRef} style={{ width: "100%", overflowX: zoom > 1 ? "auto" : "visible" }}>
        {sheets.pages.map((pageHtml, i) => (
          <div key={i} style={{ width: sheets.width * scale, height: sheets.height * scale, position: "relative", margin: "0 auto 16px", boxShadow: "0 6px 24px rgba(0,0,0,.35)", background: "#fff" }}>
            <div style={{ width: sheets.width, height: sheets.height, transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute", top: 0, left: 0 }}>
              <div className="sg-sheet" style={{ position: "absolute", inset: 0 }} dangerouslySetInnerHTML={{ __html: pageHtml }} />
              {stamps.filter((s) => s.page === i).map((s, si) => <StampView key={`s${si}`} s={s} />)}
              {placed.filter((f) => f.page === i).map((f) => (
                <FieldWidget key={f.id} f={f} value={values[f.id] ?? ""} filled={isFilled(f)} pulse={pulse === f.id}
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
                  <button type="button" id={`sg-field-${f.id}`} className={pulse === f.id ? "sg-pulse" : undefined} onClick={() => setSigningId(f.id)} style={{ ...input, textAlign: "left", cursor: "pointer", height: 48, display: "flex", alignItems: "center" }}>
                    {values[f.id] ? <img src={values[f.id]} alt="signature" style={{ height: 36 }} /> : <span style={{ color: "#94a3b8" }}>✍ Tap to sign</span>}
                  </button>
                ) : f.kind === "checkbox" ? (
                  <label id={`sg-field-${f.id}`} className={pulse === f.id ? "sg-pulse" : undefined} style={{ display: "flex", alignItems: "center", gap: 8, color: "#e2e8f0", fontSize: 14 }}>
                    <input type="checkbox" checked={values[f.id] === "true"} onChange={(e) => set(f.id, e.target.checked ? "true" : "false")} /> {f.label || "I agree"}
                  </label>
                ) : f.kind === "date" ? (
                  <div style={{ ...input, color: "#94a3b8" }}>{formatStamp(values[f.id] || todayISO())} · stamped when you sign</div>
                ) : (
                  <input type="text" id={`sg-field-${f.id}`} className={pulse === f.id ? "sg-pulse" : undefined} value={values[f.id] ?? ""} placeholder={f.label} onChange={(e) => set(f.id, e.target.value)} style={input} />
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
            <span>{SIGNING_CONSENT.text}</span>
          </label>
          {err && <div style={{ color: "#fca5a5", fontSize: 13 }}>⚠ {err}</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" disabled={busy} onClick={submit} style={{ flex: 1, minWidth: 180, background: "#ea580c", color: "#fff", border: "none", borderRadius: 8, padding: "12px 20px", fontWeight: 700, cursor: "pointer", opacity: busy ? 0.6 : 1 }}>
              {busy ? "Submitting…" : "Sign & submit"}
            </button>
            {declineDialog(<button type="button" disabled={busy} style={{ background: "transparent", color: "#e2e8f0", border: "1px solid #64748b", borderRadius: 8, padding: "12px 16px", fontWeight: 600, cursor: "pointer" }}>Decline</button>)}
            {!inPerson && questionDialog(<button type="button" disabled={busy} style={{ background: "transparent", color: "#e2e8f0", border: "1px solid #64748b", borderRadius: 8, padding: "12px 16px", fontWeight: 600, cursor: "pointer" }}>I have a question</button>)}
          </div>
          {asked && <div role="status" style={{ fontSize: 13, color: "#86efac" }}>✓ Your question was sent to {senderInline}. You can still sign or decline whenever you are ready.</div>}
          <div style={{ fontSize: 12.5, color: "#94a3b8" }}>
            {inPerson ? "" : "Unsure about something? Ask a question first — it commits you to nothing. "}
            Not ready to sign, or something needs to change? Choose Decline and tell {senderInline} why.
          </div>
        </div>
      </Card>

      {/* Sticky progress bar */}
      <div className="sg-bar">
        {(required.length > 0 || asked) && (
          <span className="sg-bar-progress" style={{ fontSize: 13, color: doneCount >= required.length ? "#4ade80" : "#94a3b8" }}>
            {required.length === 0 ? "" : doneCount >= required.length ? "✓ All fields complete" : `${doneCount} of ${required.length} required fields complete`}
            {asked && <span role="status" style={{ color: "#86efac" }}>{required.length > 0 ? " · " : ""}✓ Question sent</span>}
          </span>
        )}
        <button type="button" onClick={goNext}
          style={{ ...barButton, background: ACCENT, color: "#fff", border: `1px solid ${ACCENT}`, fontWeight: 700, padding: "9px 18px" }}>
          {todo.length > 0 ? "Next →" : "Go to sign →"}
        </button>
        {declineDialog(<button type="button" disabled={busy} style={{ ...barButton, ...quiet }}>Decline</button>)}
        {!inPerson && questionDialog(<button type="button" disabled={busy} style={{ ...barButton, ...quiet }}>Question</button>)}
      </div>

      {signingId && (
        <SignaturePad
          what={signingField?.kind === "initials" ? "initials" : "signature"}
          suggestion={signingField?.kind === "initials" ? initials : name.trim()}
          onCancel={() => setSigningId(null)}
          onDone={(url, method) => { set(signingId, url); setMethods((m) => ({ ...m, [signingId]: method })); setSigningId(null); }}
        />
      )}
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: "#fff", margin: "0 0 10px" };
const p: React.CSSProperties = { fontSize: 14, color: "#94a3b8", margin: 0 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 5 };
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 14, borderRadius: 8, border: "1px solid #334155", background: "#0f172a", color: "#e2e8f0", boxSizing: "border-box" };
const zoomButton: React.CSSProperties = { width: 36, height: 36, borderRadius: 999, border: "none", background: "transparent", color: "#fff", fontSize: 20, lineHeight: 1, cursor: "pointer" };
function Card({ children }: { children: React.ReactNode }) {
  return <div style={{ width: "100%", maxWidth: 900, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 22 }}>{children}</div>;
}
function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
