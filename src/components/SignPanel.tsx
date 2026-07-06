"use client";

import { useRef, useState } from "react";

/** Signature pad + name field on the public signing page. */
export default function SignPanel({ token, kind }: { token: string; kind: "quote" | "jobcard" }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState("");

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = e.currentTarget.width / rect.width;
    const scaleY = e.currentTarget.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext("2d")!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    hasInk.current = true;
  }

  function end() {
    drawing.current = false;
  }

  function clear() {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasInk.current = false;
  }

  async function submit() {
    setError("");
    if (name.trim().length < 2) {
      setError("Please enter your full name.");
      return;
    }
    if (!hasInk.current) {
      setError("Please draw your signature in the box.");
      return;
    }
    setStatus("sending");
    try {
      // ensure white background behind the ink
      const canvas = canvasRef.current!;
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const octx = out.getContext("2d")!;
      octx.fillStyle = "#ffffff";
      octx.fillRect(0, 0, out.width, out.height);
      octx.drawImage(canvas, 0, 0);

      const res = await fetch(`/api/sign/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name: name.trim(), signature: out.toDataURL("image/png") }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong — please try again.");
        setStatus("idle");
        return;
      }
      setStatus("done");
    } catch {
      setError("Connection problem — please try again.");
      setStatus("idle");
    }
  }

  if (status === "done") {
    return (
      <div className="rounded-xl border-2 border-emerald-600 bg-emerald-50 p-6 text-center">
        <p className="text-3xl mb-2">✅</p>
        <p className="text-lg font-bold text-emerald-800">
          {kind === "quote" ? "Quote accepted and signed" : "Job card signed"} — thank you!
        </p>
        <p className="text-sm text-emerald-700 mt-1">
          The Denago Cape Town team has been notified and will be in touch shortly.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-orange-600 bg-orange-50/60 p-5">
      <p className="text-sm font-bold uppercase tracking-widest text-orange-700 mb-3">
        {kind === "quote" ? "Accept & sign this quote" : "Sign this job card"}
      </p>
      <label className="block text-xs font-semibold text-slate-600 mb-1">Your full name *</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-orange-500 mb-3"
        placeholder="Full name"
        autoComplete="name"
      />
      <label className="block text-xs font-semibold text-slate-600 mb-1">
        Draw your signature *
      </label>
      <canvas
        ref={canvasRef}
        width={600}
        height={180}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="w-full h-36 rounded-lg border border-slate-300 bg-white touch-none cursor-crosshair"
      />
      <div className="flex items-center justify-between mt-3 gap-3 flex-wrap">
        <button
          type="button"
          onClick={clear}
          className="text-sm text-slate-500 hover:text-slate-700 underline cursor-pointer"
        >
          Clear signature
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={status === "sending"}
          className="rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 text-white font-bold px-6 py-3 cursor-pointer"
        >
          {status === "sending"
            ? "Signing…"
            : kind === "quote"
            ? "✍ Accept & sign"
            : "✍ Sign job card"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      <p className="text-[11px] text-slate-500 mt-3">
        By signing you agree to the terms above. Your name, signature, date/time and IP address
        are recorded as your electronic signature (ECT Act, 2002).
      </p>
    </div>
  );
}
