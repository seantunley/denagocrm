import crypto from "crypto";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 2048;
const MAX_PIXELS = 4_000_000;
const MAX_DECOMPRESSED = 16 * 1024 * 1024;

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  const t = table();
  for (const byte of buf) c = t[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ValidatedSignatureImage = { buffer: Buffer; width: number; height: number; sha256: string };

export function decodeAndValidateSignaturePng(dataUrl: string): ValidatedSignatureImage {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) throw new Error("Signature image must be a PNG data URL");
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded || encoded.length > Math.ceil(MAX_SIGNATURE_BYTES * 4 / 3) + 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Malformed or oversized signature image");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > MAX_SIGNATURE_BYTES || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("Invalid PNG signature image");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error("Truncated PNG chunk");
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (length > MAX_SIGNATURE_BYTES || crcOffset + 4 > buffer.length) throw new Error("Invalid PNG chunk length");
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    if (crc32(buffer.subarray(offset + 4, dataEnd)) !== expectedCrc) throw new Error("PNG integrity check failed");

    if (type === "IHDR") {
      if (sawIhdr || length !== 13 || offset !== 8) throw new Error("Invalid PNG header");
      sawIhdr = true;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colourType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filter = buffer[dataStart + 11];
      const interlace = buffer[dataStart + 12];
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new Error("Signature image dimensions are unsafe");
      if (bitDepth !== 8 || ![0, 2, 4, 6].includes(colourType!) || compression !== 0 || filter !== 0 || ![0, 1].includes(interlace!)) {
        throw new Error("Unsupported PNG encoding");
      }
      channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 4 ? 2 : 4;
      if (height * (1 + width * channels) > MAX_DECOMPRESSED) throw new Error("Signature image expands beyond the safe limit");
    } else if (type === "IDAT") {
      if (!sawIhdr || sawIend) throw new Error("Invalid PNG chunk order");
      sawIdat = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat) throw new Error("Invalid PNG terminator");
      sawIend = true;
      offset = crcOffset + 4;
      break;
    } else if (!["PLTE", "tRNS", "pHYs", "sRGB", "gAMA", "cHRM"].includes(type)) {
      throw new Error(`Unsupported PNG chunk: ${type}`);
    }
    offset = crcOffset + 4;
  }
  if (!sawIhdr || !sawIdat || !sawIend || offset !== buffer.length) throw new Error("Incomplete PNG signature image");
  return { buffer, width, height, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}
