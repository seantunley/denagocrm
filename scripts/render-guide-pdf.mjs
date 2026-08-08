/**
 * Render a print-styled HTML guide to PDF.
 *
 * Uses puppeteer-core against a locally installed Chrome rather than the CLI's
 * `--print-to-pdf`, because only the CDP path exposes `displayHeaderFooter` —
 * and a document that runs to a dozen pages without page numbers is not one you
 * hand to a customer.
 *
 * ── Why it renders twice and merges ─────────────────────────────────────────
 *
 * The cover is a full-bleed dark page. Chrome draws the running footer on EVERY
 * page when displayHeaderFooter is on, and there is no selector for "not the
 * first one" — the page number is injected as text, not exposed to CSS. Relying
 * on `@page :first { margin: 0 }` to clip it is a guess about Chrome's internals
 * that would have to be re-verified on every upgrade.
 *
 * So the cover is rendered with the footer OFF and the body with it ON, and the
 * two are stitched together. That is not a workaround for a rendering quirk; it
 * is the only version of this whose output is knowable without opening the file.
 *
 * Usage: node scripts/render-guide-pdf.mjs <input.html> <output.pdf>
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument } from "pdf-lib";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  console.error("Usage: node scripts/render-guide-pdf.mjs <input.html> <output.pdf>");
  process.exit(1);
}

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error("No Chrome or Edge found. Install one, or add its path to CHROME_CANDIDATES.");
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
if (!existsSync(input)) {
  console.error(`Input not found: ${input}`);
  process.exit(1);
}

const FOOTER = `
  <style>
    .ft {
      width: 100%;
      padding: 0 18mm;
      font-family: "Segoe UI", Arial, sans-serif;
      font-size: 7.5pt;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
  </style>
  <div class="ft">
    <span>Onboarding a new tenant</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;

const puppeteer = await import("puppeteer-core");
const browser = await puppeteer.default.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage();
  // `networkidle0` rather than `load`: the page is self-contained, but waiting for
  // quiet also gives webfonts and layout a chance to settle before we measure
  // pages. A PDF paginated mid-reflow silently splits headings from their tables.
  await page.goto(pathToFileURL(input).href, { waitUntil: "networkidle0", timeout: 60000 });

  const base = { format: "A4", printBackground: true, preferCSSPageSize: true };

  // Pass 1 — how long is it? Needed to ask for "page 2 to the end" explicitly.
  const probe = await page.pdf({ ...base });
  const total = (await PDFDocument.load(probe)).getPageCount();
  if (total < 2) {
    writeFileSync(output, probe);
    console.log(`Wrote ${output} (${total} page)`);
  } else {
    const [coverBytes, bodyBytes] = [
      await page.pdf({ ...base, pageRanges: "1", displayHeaderFooter: false }),
      await page.pdf({
        ...base,
        pageRanges: `2-${total}`,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate: FOOTER,
      }),
    ];

    const merged = await PDFDocument.create();
    for (const bytes of [coverBytes, bodyBytes]) {
      const src = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    merged.setTitle("Onboarding a new tenant");
    merged.setSubject("Standing up a customer workspace from end to end");
    merged.setCreator("DenagoCRM platform operations");

    const out = await merged.save();
    writeFileSync(output, out);
    if (merged.getPageCount() !== total) {
      console.error(
        `Merged ${merged.getPageCount()} pages but the source had ${total} — a page was lost in the split.`,
      );
      process.exit(1);
    }
    console.log(`Wrote ${output} (${total} pages, cover unnumbered)`);
  }
} finally {
  await browser.close();
}
