"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, TriangleAlert } from "lucide-react";
import { scanVehiclePhoto } from "@/app/actions/vehiclePhoto";
import type { VehiclePhotoResult } from "@/lib/vehiclePhotoRules";

/**
 * "Scan from a photo" on the vehicle form (lib/vehiclePhotoRules.ts): take or
 * choose a photo of the VIN plate, licence disc or number plate; the workspace's
 * AI reads it; what it found is shown BESIDE the photo for the person to check
 * and accept. Nothing reaches the form until they press Use.
 */
export default function VehiclePhotoScan({
  onUse,
}: {
  /** The person accepted these. Only the fields that were read are passed. */
  onUse: (found: { vin?: string; regNumber?: string; model?: string; color?: string }) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [found, setFound] = useState<VehiclePhotoResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The preview is a local object URL: released when it is replaced or the form goes away.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  async function read(file: File) {
    setBusy(true);
    setFound(null);
    setProblem(null);
    setPreview(URL.createObjectURL(file));
    try {
      const data = new FormData();
      data.set("photo", file);
      const result = await scanVehiclePhoto(data);
      if (result.ok) setFound(result.found);
      else setProblem(result.why);
    } catch {
      setProblem("The photo couldn't be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  function use() {
    if (!found) return;
    onUse({
      ...(found.vin ? { vin: found.vin } : {}),
      ...(found.regNumber ? { regNumber: found.regNumber } : {}),
      ...(found.model ? { model: found.model } : {}),
      ...(found.color ? { color: found.color } : {}),
    });
    setFound(null);
    setPreview(null);
  }

  const rows: [string, string | null][] = found
    ? [["VIN / serial number", found.vin], ["Registration", found.regNumber], ["Model", found.model], ["Colour", found.color]]
    : [];

  return (
    <div className="space-y-3 rounded-lg border border-border p-3 sm:col-span-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          id="vehicle-photo-scan"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void read(file); }}
        />
        <label htmlFor="vehicle-photo-scan" className={`btn-secondary btn-sm inline-flex cursor-pointer items-center gap-1.5 ${busy ? "pointer-events-none opacity-60" : ""}`}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Camera className="size-4" aria-hidden />}
          {busy ? "Reading the photo…" : "Scan from a photo"}
        </label>
        <p className="text-xs text-muted-foreground">Photograph the VIN plate, licence disc or number plate. The photo is read once and not kept.</p>
      </div>

      <div role="status" aria-live="polite">
        {problem && <p className="text-sm text-amber-300">{problem}</p>}
      </div>

      {found && (
        <div className="flex flex-col gap-3 sm:flex-row">
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of the photo just taken, never uploaded for display
            <img src={preview} alt="The photo you took" className="max-h-48 w-full rounded-md object-contain sm:w-56" />
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm font-medium text-foreground">Check this against the photo</p>
            <dl className="space-y-1 text-sm">
              {rows.filter(([, value]) => value).map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-36 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className={`min-w-0 break-all text-foreground ${label.startsWith("VIN") ? "font-mono tracking-wider" : ""}`}>{value}</dd>
                </div>
              ))}
            </dl>
            {found.warnings.map((warning) => (
              <p key={warning} className="flex gap-1.5 text-xs text-amber-300">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {warning}
              </p>
            ))}
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" onClick={use} className="btn-primary btn-sm">Use these details</button>
              <button type="button" onClick={() => { setFound(null); setPreview(null); }} className="btn-secondary btn-sm">Discard</button>
            </div>
            <p className="text-xs text-muted-foreground">An AI read this, so compare each character before saving. You can still edit the fields afterwards.</p>
          </div>
        </div>
      )}
    </div>
  );
}
