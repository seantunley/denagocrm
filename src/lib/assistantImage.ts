/**
 * A photo or screenshot attached to a question — checked and cleaned before the
 * model sees it, and never stored (not the database, not the logs, not Blob).
 *
 * The browser shrinks it and re-encodes it as JPEG (AssistantChat), which drops
 * the camera's metadata. The server doesn't trust that: it accepts JPEG only,
 * checks it really is one, and strips every metadata block itself — EXIF (GPS
 * location, camera serial, time), XMP, IPTC, ICC, comments — keeping only what
 * draws the picture. Pure, so it is tested byte by byte.
 */

/** After the browser's resize a photo is well under this; bigger isn't one of ours. */
export const MAX_IMAGE_BYTES = 2_000_000;
export const MAX_IMAGES_PER_QUESTION = 1;
/** The longest side the browser scales a photo down to before sending it. */
export const IMAGE_MAX_SIDE = 1600;
/** How many images one person may send an hour, on top of the ask limit. */
export const IMAGES_PER_HOUR = 30;

/**
 * A real baseline/progressive JPEG with its metadata segments removed, or null
 * when the bytes aren't one. APP1–APP15 (EXIF/XMP, ICC, Photoshop/IPTC…) and
 * COM are dropped; SOI, APP0 (JFIF), quantisation/Huffman tables, frame and
 * scan headers and the image data are kept as they are.
 */
export function cleanJpeg(input: Uint8Array): Uint8Array | null {
  const buf = input;
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    // Fill bytes before a marker.
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return null;
    const marker = buf[i];
    const start = i - 1;
    i++;
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    }
    // Markers with no length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(0xff, marker);
      continue;
    }
    if (i + 2 > buf.length) return null;
    const length = (buf[i] << 8) | buf[i + 1];
    if (length < 2 || i + length > buf.length) return null;
    const end = i + length;
    if (marker === 0xda) {
      // Start of scan: everything from here to the end is the image itself.
      for (let k = start; k < buf.length; k++) out.push(buf[k]);
      return Uint8Array.from(out);
    }
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) for (let k = start; k < end; k++) out.push(buf[k]);
    i = end;
  }
  return null; // never reached the image data
}

/** Cleaned JPEG bytes → the data: URL the model reads. */
export function jpegDataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}
