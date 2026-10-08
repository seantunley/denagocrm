/**
 * The card signature's logo panel, drawn as ONE image (Sean's mock-up,
 * 2026-10-07: a dark panel with a rounded, slanted right edge, a soft sheen,
 * the logo large on it, and an orange stripe running parallel to the slant).
 *
 * Mail clients can't draw any of that — no rounded slants, gradients or
 * transforms in email HTML — so the editor draws it here, in the owner's
 * browser, from the workspace's own logo, and uploads the PNG as the
 * signature's banner. Pure canvas, no dependencies, client-only.
 */

/** Shown at BANNER_WIDTH × BANNER_HEIGHT in the email; drawn at 960 × 300 (2.4×), so it stays sharp on retina screens. */
export const BANNER_WIDTH = 400;
export const BANNER_HEIGHT = 125;

export function drawSignatureBanner(
  canvas: HTMLCanvasElement,
  logo: HTMLImageElement,
  colours: { dark: string; accent: string },
): void {
  const W = 960;
  const H = 300;
  const top = 6;
  const bottom = H - 6;
  const r = 26; // corner radius
  const slant = 150; // how far the right edge leans across the panel's height
  const right = 900; // the panel's top-right corner
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw images.");
  ctx.clearRect(0, 0, W, H);

  // Panel: square left edge (it runs in from the edge), rounded slanted right edge.
  const len = Math.hypot(slant, bottom - top);
  const ux = -slant / len; // unit vector down the slant
  const uy = (bottom - top) / len;
  const br = { x: right - slant, y: bottom };
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(right - r, top);
  ctx.quadraticCurveTo(right, top, right + ux * r, top + uy * r);
  ctx.lineTo(br.x - ux * r, br.y - uy * r);
  ctx.quadraticCurveTo(br.x, br.y, br.x - r, bottom);
  ctx.lineTo(0, bottom);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, top, W, bottom);
  fill.addColorStop(0, colours.dark);
  fill.addColorStop(1, lighten(colours.dark, 0.06));
  ctx.fillStyle = fill;
  ctx.fill();

  // Sheen: a soft diagonal band of light across the right half.
  ctx.save();
  ctx.clip();
  const sheen = ctx.createLinearGradient(520, top, 760, bottom);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.06)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.moveTo(560, top);
  ctx.lineTo(760, top);
  ctx.lineTo(600, bottom);
  ctx.lineTo(400, bottom);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Accent stripe: parallel to the slant, just outside it, from a little below the top to the bottom.
  const gap = 14;
  const thick = 18;
  const nx = (bottom - top) / len; // unit normal, pointing right
  const ny = slant / len;
  const off = gap + thick / 2;
  ctx.strokeStyle = colours.accent;
  ctx.lineWidth = thick;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(right + nx * off + ux * 34, top + ny * off + uy * 34);
  ctx.lineTo(br.x + nx * off - ux * (thick / 2), br.y + ny * off - uy * (thick / 2));
  ctx.stroke();

  // Logo: as large as the panel allows, centred in its straight-edged part.
  const boxW = right - slant / 2 - 120;
  const boxH = (bottom - top) * 0.7;
  const fit = Math.min(boxW / logo.naturalWidth, boxH / logo.naturalHeight);
  const lw = logo.naturalWidth * fit;
  const lh = logo.naturalHeight * fit;
  ctx.drawImage(logo, 60 + (boxW - lw) / 2, top + (bottom - top - lh) / 2, lw, lh);
}

function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const rgb = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.min(255, Math.round(v + 255 * amount)));
  return `rgb(${rgb.join(",")})`;
}
