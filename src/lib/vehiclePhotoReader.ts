import "server-only";
import sharp from "sharp";
import { aiText } from "./aiText";
import { VEHICLE_PHOTO_SYSTEM, foundAnything, parseVehiclePhoto, type VehiclePhotoResult } from "./vehiclePhotoRules";

/**
 * One photo of a VIN plate, licence disc or number plate, read by the
 * workspace's own AI (lib/aiText — the same connection DAX reads pictures
 * with). The rules for what comes back are in lib/vehiclePhotoRules.ts.
 *
 * THE PHOTO IS NOT KEPT. It is resized in memory, sent for the one read and
 * dropped; nothing is written to storage or to a log but a failure's name.
 */

export type VehiclePhotoRead = { ok: true; found: VehiclePhotoResult } | { ok: false; why: string };

type Reader = (jpeg: Buffer) => Promise<string | { failure: string }>;
let override: Reader | null = null;
/** Tests only: read a photo without calling an AI. */
export function __setVehiclePhotoReaderForTests(reader: Reader | null): void {
  override = reader;
}

async function askAi(jpeg: Buffer): Promise<string | { failure: string }> {
  const result = await aiText({
    scope: "vehicle-photo-read",
    system: VEHICLE_PHOTO_SYSTEM,
    prompt: "Read this photo.",
    images: [{ mediaType: "image/jpeg", base64: jpeg.toString("base64") }],
    maxTokens: 300,
    timeoutMs: 45_000,
  });
  return result.ok ? result.text : { failure: result.failure };
}

export async function readVehiclePhoto(photo: Buffer): Promise<VehiclePhotoRead> {
  let jpeg: Buffer;
  try {
    // Upright, at most 1600px a side: stamped characters stay sharp and the upload stays small.
    jpeg = await sharp(photo, { failOn: "none", limitInputPixels: 60_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return { ok: false, why: "That file isn't a photo I can open. Take the photo again, or choose a JPEG or PNG." };
  }
  const reply = await (override ?? askAi)(jpeg);
  if (typeof reply !== "string") {
    return {
      ok: false,
      why:
        reply.failure === "not_configured"
          ? "No AI is connected to this workspace to read photos. An owner can connect one under Settings → Integrations."
          : reply.failure === "no_credit"
            ? "The workspace's AI is out of credit, so the photo couldn't be read. Type the details in for now."
            : "The photo couldn't be read just now. Try again in a moment, or type the details in.",
    };
  }
  const found = parseVehiclePhoto(reply);
  if (!found || !foundAnything(found)) {
    return { ok: false, why: "I couldn't read a VIN or registration in that photo. Move closer, avoid glare, and make sure the whole plate or disc is in the frame." };
  }
  return { ok: true, found };
}
