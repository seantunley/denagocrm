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
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
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
