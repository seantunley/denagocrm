/**
 * Is this logo drawn in light colours on a see-through background — made for a DARK page?
 *
 * Denago Cape Town's logo is white lettering on transparency (85% of what is drawn is near-white), so on a white
 * PDF header it all but vanished (Sean, 2026-11-14). Such a logo is put on a dark panel; every other logo is drawn
 * as it is. A logo with its own solid background (a JPEG, a filled PNG) carries its own contrast, so it never counts.
 */
const NEAR_WHITE = 215; // luminance, 0–255
const LIGHT_SHARE = 0.5; // of the drawn pixels
const SEE_THROUGH_SHARE = 0.05; // of all pixels: below this, it has its own background

export async function logoIsLight(png: Buffer): Promise<boolean> {
  const { default: sharp } = await import("sharp");
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let drawn = 0;
  let light = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    drawn++;
    if (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2] > NEAR_WHITE) light++;
  }
  if (!drawn || (pixels - drawn) / pixels < SEE_THROUGH_SHARE) return false;
  return light / drawn >= LIGHT_SHARE;
}
