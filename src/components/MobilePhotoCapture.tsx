"use client";

import { Camera } from "lucide-react";
import type { ActionResult } from "@/lib/actionResultTypes";
import PhotoUploadField from "@/components/PhotoUploadField";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import type { OfflineDescriptor } from "@/lib/offlineTypes";

export function MobilePhotoCapture({
  action,
  label,
  success = "Photos uploaded",
  offlineOperation,
}: {
  action: (formData: FormData) => Promise<ActionResult | void>;
  label: string;
  success?: string;
  offlineOperation?: OfflineDescriptor;
}) {
  return (
    <SaveForm action={action} success={success} offlineOperation={offlineOperation} className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.055] p-2.5">
      <label className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Camera className="size-3.5 text-primary" />
        {label}
      </label>
      <PhotoUploadField
        required
        className="block w-full text-xs text-muted-foreground file:mr-2 file:rounded-lg file:border-0 file:bg-muted file:px-2.5 file:py-1.5 file:text-xs file:font-medium file:text-foreground"
      />
      <SaveButton className="btn-primary mt-2 w-full" pendingLabel="Preparing photos…">
        <Camera className="size-4" /> Take or choose photos
      </SaveButton>
    </SaveForm>
  );
}
