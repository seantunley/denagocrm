// Generates the "Denago Messages" PWA icons from an inline SVG source, so the
// icon set is reproducible (edit the SVG here, re-run `node scripts/gen-messages-icons.mjs`).
// Mark: the Denago "D" in brand orange with a lightning bolt driven through it,
// on the dark navy tile. Requires sharp (already a dependency).
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const icons = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const defs = `
  <defs>
    <linearGradient id="bgg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0c1626"/>
      <stop offset="1" stop-color="#020617"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.4" r="0.62">
      <stop offset="0" stop-color="#f97316" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#f97316" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fdba74"/>
      <stop offset="0.45" stop-color="#f97316"/>
      <stop offset="1" stop-color="#ea580c"/>
    </linearGradient>
    <filter id="sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.40"/>
    </filter>
  </defs>`;

// The Denago "D" (thick stroked stem + bowl) with a white lightning bolt through
// it. The bolt carries a navy halo (paint-order:stroke) so a dark gap separates
// it from the orange D — reading as "driven through".
const mark = `
  <g filter="url(#sh)">
    <path d="M160 120 L160 392 M160 120 C 308 120 372 182 372 256 C 372 330 308 392 160 392"
          fill="none" stroke="url(#dg)" stroke-width="84" stroke-linecap="round" stroke-linejoin="round"/>
    <g transform="translate(252 256) scale(1.15)" paint-order="stroke"
       stroke="#020617" stroke-width="22" stroke-linejoin="round">
      <path d="M 40 -140 L -48 20 L 6 20 L -28 140 L 70 -30 L 14 -30 Z" fill="#ffffff"/>
    </g>
  </g>`;

// Standard rounded-tile icon (used on Android home screens / apple-touch).
const tile = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">${defs}
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#bgg)"/>
  <rect x="0" y="0" width="512" height="512" rx="112" fill="url(#glow)"/>
  ${mark}
</svg>`;

// Maskable icon: full-bleed background (the launcher applies its own mask), with
// the mark scaled into the ~80% safe zone so nothing important gets clipped.
const maskable = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">${defs}
  <rect x="0" y="0" width="512" height="512" fill="url(#bgg)"/>
  <rect x="0" y="0" width="512" height="512" fill="url(#glow)"/>
  <g transform="translate(256 256) scale(0.78) translate(-256 -256)">${mark}</g>
</svg>`;

async function main() {
  await writeFile(join(icons, "messages-icon.svg"), tile.trim());
  const png = (svg, size, file) =>
    sharp(Buffer.from(svg)).resize(size, size).png().toFile(join(icons, file));
  await Promise.all([
    png(tile, 192, "messages-192.png"),
    png(tile, 512, "messages-512.png"),
    png(tile, 180, "messages-apple-180.png"),
    png(maskable, 512, "messages-maskable-512.png"),
  ]);
  console.log("Wrote messages-icon.svg + messages-{192,512,apple-180,maskable-512}.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
