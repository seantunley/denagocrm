import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import { SECURE_LINK_TOKEN } from "@/lib/secureLinks";
import { findDocumentRequest } from "@/lib/documentRequests";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveDocumentRequestTenant } from "@/lib/tokenTenant";

export const dynamic = "force-dynamic";
// A private link: never indexed, never cached, and it does not leak itself to wherever the reader goes next.
export const metadata: Metadata = { title: "Upload a document", robots: { index: false, follow: false }, referrer: "no-referrer" };

function Shell({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff", textTransform: "uppercase" }}>{brand}</div>
      <div style={{ width: "100%", maxWidth: 480, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28, textAlign: "center" }}>{children}</div>
    </div>
  );
}

/**
 * Where a supplier's document request lands (lib/documentRequests.ts). Opening it changes nothing — mail gateways
 * open every link to scan it — the file moves only when the supplier picks one and presses Upload (a POST to
 * /api/u/<token>). A request that is answered, recalled or expired says so plainly.
 */
export default async function DocumentRequestPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { token } = await params;
  const query = await searchParams;
  if (!SECURE_LINK_TOKEN.test(token)) notFound();
  return withTokenTenantScope(
    () => resolveDocumentRequestTenant(token),
    () => render(token, query),
    () => notFound(),
  );
}

const ERRORS: Record<string, string> = {
  type: "That file isn't a PDF or a photo (JPG, PNG or WebP). Please choose the document itself.",
  size: "That file is over 4 MB. Please send a smaller copy — a PDF, or a photo at a lower size.",
  empty: "Choose the file first.",
  failed: "That didn't go through. Please try again in a moment.",
};

async function render(token: string, query: { sent?: string; error?: string }) {
  const request = await findDocumentRequest(token);
  if (!request) notFound();
  const brand = (await brandForTenant(request.tenantId).catch(() => DEFAULT_BRAND)).displayName;
  const title = { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 } as const;
  const muted = { fontSize: 14, color: "#94a3b8", lineHeight: 1.5 } as const;
  const what = request.documentType.toLowerCase();

  if (request.state === "received") {
    return (
      <Shell brand={brand}>
        <div style={title}>{query.sent ? "Thank you — it's uploaded" : "Already received"}</div>
        <div style={muted}>{brand} has your {what} for Q-{request.quoteNumber}. You can close this page.</div>
      </Shell>
    );
  }
  if (request.state === "recalled") {
    return <Shell brand={brand}><div style={title}>This request was withdrawn</div><div style={muted}>{brand} no longer needs this upload. If you think they do, please contact them.</div></Shell>;
  }
  if (request.state === "expired") {
    return <Shell brand={brand}><div style={title}>This link has expired</div><div style={muted}>It stopped working on {formatDateTime(request.expiresAt)}. Please ask {brand} to send it again.</div></Shell>;
  }
  return (
    <Shell brand={brand}>
      <div style={{ ...muted, marginBottom: 6 }}>{brand} asks {request.vendorName} for</div>
      <div style={{ ...title, wordBreak: "break-word" }}>Your {what} for Q-{request.quoteNumber}</div>
      {query.error && ERRORS[query.error] && <div style={{ fontSize: 14, color: "#fca5a5", margin: "10px 0" }}>{ERRORS[query.error]}</div>}
      <form method="post" action={`/api/u/${token}`} encType="multipart/form-data" style={{ marginTop: 16 }}>
        <input type="file" name="file" required accept="application/pdf,image/jpeg,image/png,image/webp" style={{ display: "block", width: "100%", margin: "0 auto 16px", color: "#e2e8f0" }} />
        <button type="submit" style={{ background: "#ea580c", color: "#fff", border: 0, borderRadius: 8, padding: "12px 22px", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Upload</button>
      </form>
      <div style={{ ...muted, marginTop: 18, fontSize: 12 }}>
        A PDF or a photo of it, up to 4 MB. This link works once, until {formatDateTime(request.expiresAt)}. Please don&apos;t forward it.
      </div>
    </Shell>
  );
}
