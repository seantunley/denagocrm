// Generates the Android launcher shortcut icons from inline vector artwork.
// Re-run with `node scripts/gen-pwa-shortcut-icons.mjs` after editing.
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  "icons",
);

const shortcuts = [
  {
    file: "shortcut-lead-192.png",
    start: "#ff8a3d",
    end: "#ea580c",
    artwork: `
      <path d="M2 21a8 8 0 0 1 13.292-6"/>
      <circle cx="10" cy="8" r="5"/>
      <path d="M19 16v6M22 19h-6"/>
    `,
  },
  {
    file: "shortcut-contact-192.png",
    start: "#2dd4bf",
    end: "#0891b2",
    artwork: `
      <path d="M8 2v2M16 2v2"/>
      <path d="M17.915 22a6 6 0 0 0-11.83 0"/>
      <circle cx="12" cy="12" r="4"/>
      <rect x="3" y="4" width="18" height="18" rx="2"/>
    `,
  },
  {
    file: "shortcut-activity-192.png",
    start: "#8b5cf6",
    end: "#4f46e5",
    artwork: `
      <path d="M8 2v4M16 2v4"/>
      <rect width="18" height="18" x="3" y="4" rx="2"/>
      <path d="M3 10h18M10 16h4M12 14v4"/>
    `,
  },
  {
    file: "shortcut-chats-192.png",
    start: "#fb923c",
    end: "#ea580c",
    artwork: `
      <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
      <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1"/>
    `,
  },
  {
    file: "shortcut-helpdesk-192.png",
    start: "#38bdf8",
    end: "#0284c7",
    artwork: `
      <path d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"/>
      <path d="M21 16v2a4 4 0 0 1-4 4h-5"/>
    `,
  },
];

function shortcutSvg({ start, end, artwork }) {
  return `
    <svg width="192" height="192" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="icon" x1="30" y1="24" x2="162" y2="168" gradientUnits="userSpaceOnUse">
          <stop stop-color="${start}"/>
          <stop offset="1" stop-color="${end}"/>
        </linearGradient>
        <filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">
          <feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#020617" flood-opacity=".55"/>
        </filter>
      </defs>
      <g transform="translate(24 20) scale(6)" fill="none" stroke="#020617" stroke-width="3.4"
         stroke-linecap="round" stroke-linejoin="round" opacity=".78">
        ${artwork}
      </g>
      <g transform="translate(24 20) scale(6)" fill="none" stroke="url(#icon)" stroke-width="2.15"
         stroke-linecap="round" stroke-linejoin="round" filter="url(#shadow)">
        ${artwork}
      </g>
    </svg>
  `;
}

await Promise.all(
  shortcuts.map((shortcut) =>
    sharp(Buffer.from(shortcutSvg(shortcut)))
      .png()
      .toFile(join(outputDirectory, shortcut.file)),
  ),
);

console.log(`Wrote ${shortcuts.map(({ file }) => file).join(", ")}`);
