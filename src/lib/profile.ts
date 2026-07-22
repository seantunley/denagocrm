export const PROFILE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

export type ProfileImageMime = "image/jpeg" | "image/png" | "image/webp";

export function detectProfileImageMime(bytes: Uint8Array): ProfileImageMime | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function normalisePhone(value: string): string | null {
  const phone = value.trim().replace(/\s+/g, " ");
  return phone || null;
}

export function isValidPhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  return !value || (digits.length >= 7 && digits.length <= 15 && /^[+()\d .-]+$/.test(value));
}
