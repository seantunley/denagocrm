import sharp from "sharp";
import { logoBacking } from "./appIcon";

/**
 * A picture, whole, centred on a square with `padding` each side: on its own backdrop colour when it is opaque (its
 * top-left pixel continued), else dark or white to suit its visible pixels. Used by /api/brand/icon for logos and for
 * an uploaded icon's maskable form. Server only (sharp).
 */
export async function onSquare(bytes: Buffer, size: number, padding: number): Promise<Buffer> {
  const inner = Math.round(size * (1 - 2 * padding));
  const image = sharp(bytes, { density: 300 }).rotate();
  const { hasAlpha } = await image.metadata();
  let backing: string;
  if (hasAlpha) {
    // Average brightness of the visible pixels only.
    const { data } = await image.clone().resize(48, 48, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let weight = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      weight += a;
      light += a * ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
    }
    backing = logoBacking(weight ? light / weight : 0);
  } else {
    // An opaque picture carries its own background: continue it from the top-left pixel.
    const { data } = await image.clone().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    backing = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const drawn = await image.resize(inner, inner, { fit: "inside" }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: backing } })
    .composite([{ input: drawn, gravity: "center" }])
    .png()
    .toBuffer();
}
