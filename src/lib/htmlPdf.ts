/**
 * Renders a page of this app to PDF using headless Chromium — so generated
 * PDFs are pixel-identical to the print pages. Falls back to null when
 * Chromium isn't available (e.g. local Windows dev) — callers then use the
 * pdf-lib fallback.
 */
export async function renderUrlToPdf(url: string): Promise<Buffer | null> {
  try {
    const [{ default: chromium }, { default: puppeteer }] = await Promise.all([
      import("@sparticuz/chromium"),
      import("puppeteer-core"),
    ]);

    let executablePath: string | null = null;
    try {
      executablePath = await chromium.executablePath();
    } catch {
      executablePath = null;
    }
    if (!executablePath) {
      // local dev fallback: system Chrome
      const candidates = [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ];
      const fs = await import("fs");
      executablePath = candidates.find((p) => fs.existsSync(p)) ?? null;
    }
    if (!executablePath) return null;

    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle0", timeout: 25_000 });
      const pdf = await page.pdf({
        format: "a4",
        printBackground: true,
        preferCSSPageSize: false,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    console.error("[htmlPdf] render failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
