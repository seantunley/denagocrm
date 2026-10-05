/**
 * A photo or screenshot → a small JPEG, in the browser, before it is sent. The
 * longest side is scaled to `maxSide`, the picture is redrawn on a canvas (so
 * the camera's EXIF — GPS location, serial numbers, time — is not carried over;
 * the server strips metadata again regardless), and transparency is filled white.
 * Null when the browser can't read the file (e.g. HEIC outside Safari).
 */
export async function shrinkToJpeg(file: Blob, maxSide: number, maxBytes: number): Promise<Blob | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= maxBytes) return blob;
    }
    return null;
  } catch {
    return null;
  }
}
