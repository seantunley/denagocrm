"use server";

import { withActingStaffScope } from "@/lib/actingScope";
import { requirePermission } from "@/lib/permissions";
import { rateLimitKey, reserveRateLimitAttempt, type RateLimitPolicy } from "@/lib/rateLimit";
import { sniffKind } from "@/lib/assistantFileReading";
import { readVehiclePhoto, type VehiclePhotoRead } from "@/lib/vehiclePhotoReader";
import { VEHICLE_PHOTO_MAX_BYTES } from "@/lib/vehiclePhotoRules";

/**
 * "Scan from a photo" on the vehicle form: read the VIN and registration from a
 * photo and hand them back for the person to accept. Saves nothing.
 *
 * Open to whoever may add or edit vehicles — the same permission the form's own
 * save needs. Each read spends the workspace's AI allowance, so it is limited
 * per person: generous for a day of deliveries, useless for hammering.
 */
const SCAN_POLICY: RateLimitPolicy = { limit: 40, windowMs: 60 * 60 * 1000, blockMs: 10 * 60 * 1000 };

export async function scanVehiclePhoto(formData: FormData): Promise<VehiclePhotoRead> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("vehicles.manage");

    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) return { ok: false, why: "Choose or take a photo first." };
    if (file.size > VEHICLE_PHOTO_MAX_BYTES) return { ok: false, why: "That photo is too large (over 12 MB). Take it again at a lower quality." };

    const bytes = Buffer.from(await file.arrayBuffer());
    // By its bytes, not its name: a renamed file is still what it is.
    if (sniffKind(bytes) !== "picture") return { ok: false, why: "That file isn't a photo. Choose a JPEG, PNG, WebP or HEIC picture." };

    const limit = await reserveRateLimitAttempt(rateLimitKey("vehicle-photo-scan", user.id), SCAN_POLICY);
    if (!limit.allowed) {
      const minutes = Math.max(1, Math.ceil(limit.retryAfterSeconds / 60));
      return { ok: false, why: `That's a lot of scans in a short time. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}, or type the details in.` };
    }
    return readVehiclePhoto(bytes);
  });
}
