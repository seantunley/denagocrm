import type { NextConfig } from "next";

// @sparticuz/chromium ships the browser as bin/chromium.br (~64 MB) which
// chromium.executablePath() reads at RUNTIME. Next's tracer can't see that
// runtime read, so Vercel omits the bin/ folder from the function and PDF
// generation dies with "…/@sparticuz/chromium/bin does not exist". Externalizing
// the package (below) stops the bundler mangling it but does NOT force those
// files in — outputFileTracingIncludes does, scoped to the routes that render
// PDFs (signing send + document studio + public sign completion).
const CHROMIUM_FILES = "./node_modules/@sparticuz/chromium/**/*";

/**
 * Content-Security-Policy, in two parts — see the headers() block below.
 *
 * A word on what this does and does not buy: the report-only policy keeps
 * `'unsafe-inline'` in script-src, because Next inlines its hydration
 * bootstrap. With that present a CSP does NOT stop XSS, so this is defence in
 * depth, not the control that saves you — escaping at the render site still is.
 * Moving to nonces would make it a real XSS control and is the next step.
 */
const CSP_ENFORCED = [
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // data: for the logo/signature data URIs stamped into documents; blob: for the
  // signature pad's canvas capture.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
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
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // ENFORCED: only the directives that cannot break a working Next app.
          // Each one closes a real hole and none of them constrain script or
          // style, which is where breakage lives:
          //   base-uri     — an injected <base> can't repoint every relative URL
          //   object-src   — no <object>/<embed> plugin execution
          //   form-action  — an injected form can't POST credentials off-site
          //   frame-ancestors — clickjacking (X-Frame-Options above, for modern UAs)
          { key: "Content-Security-Policy", value: CSP_ENFORCED },
          // REPORT-ONLY: the policy we actually want. script-src/style-src would
          // break Next's inline hydration bootstrap and the document studio's
          // injected <style>, so it ships as violations-in-the-console first.
          // Read the console on the real app, fix what it flags, then promote.
          // Deliberately no report-uri: that means an unauthenticated POST
          // endpoint to collect and store attacker-controlled JSON.
          { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
        ],
      },
    ];
  },
};

export default nextConfig;
