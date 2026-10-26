import type { NextConfig } from "next";

// @sparticuz/chromium ships the browser as bin/chromium.br (~64 MB) which
// chromium.executablePath() reads at RUNTIME. Next's tracer can't see that
// runtime read, so Vercel omits the bin/ folder from the function and PDF
// generation dies with "…/@sparticuz/chromium/bin does not exist". Externalizing
// the package (below) stops the bundler mangling it but does NOT force those
// files in — outputFileTracingIncludes does, scoped to the routes that render
// PDFs (signing send + document studio + public sign completion).
const CHROMIUM_FILES = "./node_modules/@sparticuz/chromium/**/*";

const nextConfig: NextConfig = {
  /*
   * Do not announce the framework in every response.
   *
   * `X-Powered-By: Next.js` went out on every request and told a scanner which
   * framework — and so which CVE list — to try. It is low severity on its own
   * (an attacker can usually fingerprint a site anyway) and it is also free to
   * remove, which is the whole argument: there is no reason to hand it over.
   * Flagged by an OWASP ZAP scan, 2026-09-01.
   */
  poweredByHeader: false,
  // unpdf (DAX reading a PDF's text) ships PDF.js as one 1.6 MB module it imports on demand: loaded from
  // node_modules at runtime rather than bundled into every server chunk that reaches the assistant.
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core", "unpdf"],
  // A Server Action request body is capped at 1 MB by default, and the photo
  // upload actions accept twelve files of up to 4 MB each. Nothing declared a
  // limit, so the framework rejected an ordinary phone photo before
  // uploadJobCardPhotos ever ran its own validation: the camera flow worked in a
  // desktop review and could not work on a phone.
  //
  // This is the DECLARED half of the fix. The other half matters more —
  // components/PhotoUploadField.tsx resizes images to 1600px before sending, so
  // a real upload is a few megabytes rather than tens. Raising the limit alone
  // would have made the feature technically function by pushing unnecessary
  // pixels over a mobile connection.
  //
  // Kept ABOVE MAX_UPLOAD_TOTAL_BYTES in lib/photoBudget.ts, which the actions
  // enforce: the request also carries form fields and multipart boundaries, so a
  // payload cap equal to this would be refused by the framework and the person
  // would see a generic failure instead of an explanation. A test pins the
  // ordering of the two numbers.
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
  },
  outputFileTracingIncludes: {
    "/quotes/**": [CHROMIUM_FILES],
    "/jobcards/**": [CHROMIUM_FILES],
    "/document-studio": [CHROMIUM_FILES],
    "/settings/documents/**": [CHROMIUM_FILES],
    // Completion SEALS the final PDF via chromium too, wherever the last signature
    // lands: the in-person hub surface (/signatures/[id]/sign/…), the public
    // customer link (/api/signing), and the legacy link (/api/sign). #57 covered
    // send but not these, so completion would still hit the chromium error.
    "/signatures/**": [CHROMIUM_FILES],
    "/api/signing/**": [CHROMIUM_FILES],
    "/api/sign/**": [CHROMIUM_FILES],
    // A QUOTE'S PDF IS NOW MADE IN FOUR MORE PLACES, and each failed in production
    // with the chromium error until it was listed here (found 2026-10-12, when a
    // quote DAX built arrived on WhatsApp without its PDF — locally these all pass,
    // because a dev machine renders with its own Chrome):
    //  - the WhatsApp webhook: a tapped Confirm on a quote DAX built, and the
    //    catch-up of waiting updates on any message from a linked staff phone;
    //  - the assistant's cron tick: the half-hourly retry of a PDF still waiting;
    //  - a lead's and a customer's page: "Attach quote" in the email composer
    //    renders the quote there (and the quote editor's "Email quote" opens there);
    //  - the Ask page: confirming a quote DAX built, in the CRM chat.
    // tests/pdfRoutesBundleChromium.test.ts keeps this list honest.
    "/api/webhooks/whatsapp": [CHROMIUM_FILES],
    "/api/cron/assistant": [CHROMIUM_FILES],
    "/leads/**": [CHROMIUM_FILES],
    "/contacts/**": [CHROMIUM_FILES],
    "/assistant": [CHROMIUM_FILES],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // SAMEORIGIN (not DENY): the Documents template studio previews our
          // own print pages in an iframe; external sites still can't frame us.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // microphone=(self), not (): the empty list forbade the microphone
            // on every page of the site, whatever the browser allowed — so
            // asking DAX by voice and voice debriefs failed everywhere with
            // "allow it for this site". Our own pages only; never third parties.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // Content-Security-Policy is NOT set here. It needs a per-request
          // nonce, so it is built in src/proxy.ts (see src/lib/csp.ts). Setting
          // it in both places would send two enforced policies, and a browser
          // applies the INTERSECTION — the static one, having no nonce, would
          // block every script the proxy had just authorised.
        ],
      },
    ];
  },
};

export default nextConfig;
