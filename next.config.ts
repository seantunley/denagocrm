import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // pdfme's PDF renderer (clawpdf/pdfium) references Node's `module`
      // builtin behind a runtime Node-only guard. Stub it for the browser so
      // Turbopack can bundle it; the guarded code never runs client-side.
      module: { browser: "./src/stubs/empty.ts" },
    },
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
            value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
