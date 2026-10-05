/**
 * A photo or screenshot attached to a question — checked and cleaned before the
 * model sees it, and never stored (not the database, not the logs, not Blob).
 *
 * The browser shrinks it and re-encodes it as JPEG (AssistantChat), which drops
 * the camera's metadata. The server doesn't trust that: it accepts JPEG only and
 * REBUILDS it from a whitelist — see cleanJpeg. Pure, so it is tested byte by byte.
 */

/** After the browser's resize a photo is well under this; bigger isn't one of ours. */
export const MAX_IMAGE_BYTES = 2_000_000;
export const MAX_IMAGES_PER_QUESTION = 1;
/** The longest side the browser scales a photo down to before sending it. */
export const IMAGE_MAX_SIDE = 1600;
/** How many images one person may send an hour, on top of the ask limit. */
export const IMAGES_PER_HOUR = 30;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DHT = 0xc4;
const DRI = 0xdd;
/** Start-of-frame markers: baseline, extended, progressive, lossless (Huffman). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7]);

/**
 * Does a kept header segment's declared length EXACTLY match its own contents?
 * A length that runs past the tables it describes could carry hidden bytes.
 * `body` is the segment after its two length bytes.
 */
function exactlyFilled(marker: number, body: Uint8Array): boolean {
  if (marker === DQT) {
    // One or more tables: 1 byte (precision << 4 | id) + 64 or 128 bytes.
    let i = 0;
    while (i < body.length) {
      const precision = body[i] >> 4;
      if (precision > 1 || (body[i] & 0x0f) > 3) return false;
      i += 1 + (precision ? 128 : 64);
    }
    return i === body.length;
  }
  if (marker === DHT) {
    // One or more tables: 1 byte (class/id) + 16 counts + that many symbols.
    let i = 0;
    while (i < body.length) {
      if (i + 17 > body.length || (body[i] >> 4) > 1 || (body[i] & 0x0f) > 3) return false;
      let symbols = 0;
      for (let k = 1; k <= 16; k++) symbols += body[i + k];
      i += 17 + symbols;
    }
    return i === body.length;
  }
  if (SOF.has(marker)) return body.length >= 6 && body.length === 6 + 3 * body[5];
  if (marker === SOS) return body.length >= 1 && body.length === 4 + 2 * body[0];
  if (marker === DRI) return body.length === 2;
  return false;
}

/**
 * The image rebuilt from a WHITELIST, or null when the bytes aren't a complete
 * JPEG. Parsed all the way to EOI — including the entropy-coded data of every
 * scan (a progressive JPEG has several), where only byte-stuffed 0xFF00 and the
 * restart markers RST0–7 are allowed through:
 *  - kept: SOI, quantisation (DQT) and Huffman (DHT) tables, the frame header
 *    (SOFn), restart interval (DRI), scan headers (SOS) and their image data,
 *    RSTn, EOI — each header only if its length exactly matches its contents;
 *  - dropped wherever they appear, including BETWEEN scans: every APPn (EXIF/
 *    GPS, XMP, ICC, Photoshop/IPTC, even the JFIF header and its thumbnail) and
 *    every comment (COM);
 *  - dropped: anything after EOI;
 *  - refused (null): any other marker, a second SOI, a truncated segment or
 *    scan, a header with spare bytes, no frame or scan, no EOI.
 */
export function cleanJpeg(input: Uint8Array): Uint8Array | null {
  const buf = input;
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) return null;
  const out: number[] = [0xff, SOI];
  let i = 2;
  let sawFrame = false;
  let sawScan = false;

  for (;;) {
    // A marker: 0xFF, optional 0xFF fill bytes, then the marker code.
    if (i >= buf.length || buf[i] !== 0xff) return null;
    while (i < buf.length && buf[i] === 0xff) i++;
    if (i >= buf.length) return null;
    const marker = buf[i++];

    if (marker === EOI) {
      if (!sawFrame || !sawScan) return null;
      out.push(0xff, EOI);
      return Uint8Array.from(out); // whatever followed EOI is not copied
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(0xff, marker); // a restart marker between segments: harmless, kept
      continue;
    }

    if (i + 2 > buf.length) return null;
    const length = (buf[i] << 8) | buf[i + 1];
    if (length < 2 || i + length > buf.length) return null;
    const body = buf.subarray(i + 2, i + length);
    i += length;

    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (metadata) continue; // APPn / COM: dropped, wherever they are
    if (marker !== DQT && marker !== DHT && marker !== DRI && marker !== SOS && !SOF.has(marker)) return null;
    if (!exactlyFilled(marker, body)) return null;
    if (SOF.has(marker)) {
      if (sawFrame) return null; // one frame per image
      sawFrame = true;
    }
    if (marker === SOS && !sawFrame) return null;

    out.push(0xff, marker, length >> 8, length & 0xff);
    for (const byte of body) out.push(byte);

    if (marker === SOS) {
      sawScan = true;
      // The scan's image data, up to the next real marker. Inside it a 0xFF is
      // only ever 0xFF00 (a stuffed byte) or 0xFFD0–D7 (restart); anything else
      // ends the scan and is parsed as a marker above — so metadata placed
      // between scans is seen, and dropped, like any other.
      for (;;) {
        if (i >= buf.length) return null; // the file ended inside a scan
        const byte = buf[i];
        if (byte !== 0xff) {
          out.push(byte);
          i++;
          continue;
        }
        let j = i + 1;
        while (j < buf.length && buf[j] === 0xff) j++;
        if (j >= buf.length) return null;
        const next = buf[j];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          out.push(0xff, next);
          i = j + 1;
          continue;
        }
        i = j - 1; // the 0xFF that starts the next marker
        break;
      }
    }
  }
}

/** Cleaned JPEG bytes → the data: URL the model reads. */
export function jpegDataUrl(bytes: Uint8Array): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}
