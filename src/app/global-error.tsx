"use client";

/**
 * Last-resort error page: shown when the root layout itself throws, which is
 * the one moment nothing else in the app is available to help.
 *
 * It is built to work with NO JavaScript, on purpose.
 *
 * global-error REPLACES the root layout, so it does not inherit that layout's
 * `force-dynamic` — the build prerenders it, its scripts carry no CSP nonce,
 * and `strict-dynamic` blocks them. That is not a bug to chase: there is no
 * route segment config on this file to fix it. The answer is to need nothing
 * from those scripts.
 *
 * So there is deliberately no `reset()` button. React passes one, and it is the
 * idiomatic thing to render — but here it would be a button that never responds,
 * which is worse than not offering it. Plain links always work.
 *
 * Styling is inline rather than from globals.css for the same reason: if the
 * failure is in the build or the stylesheet, an import is one more thing that
 * can fail. `style-src 'unsafe-inline'` covers this (see src/lib/csp.ts).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#020617",
          color: "#e2e8f0",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          lineHeight: 1.5,
        }}
      >
        <main style={{ maxWidth: "30rem", width: "100%" }}>
          <div style={{ height: "3px", width: "48px", backgroundColor: "#ea580c", borderRadius: "2px" }} />

          <h1 style={{ margin: "20px 0 8px", fontSize: "1.5rem", fontWeight: 700, color: "#f8fafc" }}>
            Something went wrong
          </h1>

          <p style={{ margin: "0 0 20px", color: "#94a3b8", fontSize: "0.95rem" }}>
            Denago CRM hit an error it couldn&apos;t recover from. Your data is safe — nothing was
            saved from the page you were on.
          </p>

          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "20px" }}>
            {/* Plain links, not buttons: these work with scripts blocked.
                And a plain <a>, not next/link, for two reasons — it imports
                nothing from the runtime that may itself be what failed, and it
                forces a FULL document load, which throws away the broken client
                state. A soft navigation back into a crashed app is not a
                recovery. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              style={{
                display: "inline-block",
                padding: "9px 16px",
                borderRadius: "8px",
                backgroundColor: "#ea580c",
                color: "#ffffff",
                fontWeight: 600,
                fontSize: "0.9rem",
                textDecoration: "none",
              }}
            >
              Back to the dashboard
            </a>
            <a
              href="/login"
              style={{
                display: "inline-block",
                padding: "9px 16px",
                borderRadius: "8px",
                border: "1px solid #334155",
                color: "#e2e8f0",
                fontWeight: 600,
                fontSize: "0.9rem",
                textDecoration: "none",
              }}
            >
              Sign in again
            </a>
          </div>

          {/* Next replaces the message with an opaque digest in production. It is
              the only handle support has on which error this was, so show it. */}
          {error?.digest && (
            <p style={{ margin: 0, fontSize: "0.75rem", color: "#64748b" }}>
              Quote this reference if you report it:{" "}
              <code
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  color: "#94a3b8",
                }}
              >
                {error.digest}
              </code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
