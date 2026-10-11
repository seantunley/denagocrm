import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDateTime } from "@/lib/format";
import { fileSizeLabel, SECURE_LINK_TOKEN } from "@/lib/secureLinks";
import { findSecureLink } from "@/lib/secureLinkStore";
import { brandForTenant, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSecureFileTenant } from "@/lib/tokenTenant";

export const dynamic = "force-dynamic";
// A private link: never indexed, never cached, and it does not leak itself to wherever the reader goes next.
export const metadata: Metadata = { title: "Secure file", robots: { index: false, follow: false }, referrer: "no-referrer" };

function Shell({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff", textTransform: "uppercase" }}>{brand}</div>
      <div style={{ width: "100%", maxWidth: 480, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28, textAlign: "center" }}>{children}</div>
    </div>
  );
}

/**
 * Where a secure link lands (lib/secureLinks.ts). Opening this page downloads
 * NOTHING and counts nothing: mail gateways open every link in an email to scan
 * it, and a page that handed over the file on a plain visit would hand it to the
 * scanner and report it as read. The file moves only when the button is pressed
 * (a POST to /api/f/<token>).
 *
 * A link that is recalled or expired says so plainly — "page not found" would
 * leave a customer unable to tell a withdrawn document from a broken link.
 */
export default async function SecureFilePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!SECURE_LINK_TOKEN.test(token)) notFound();
  return withTokenTenantScope(
    () => resolveSecureFileTenant(token),
    () => render(token),
    () => notFound(),
  );
}

async function render(token: string) {
  const link = await findSecureLink(token);
  if (!link) notFound();
  const brand = (await brandForTenant(link.tenantId).catch(() => DEFAULT_BRAND)).displayName;
  const title = { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 } as const;
  const muted = { fontSize: 14, color: "#94a3b8", lineHeight: 1.5 } as const;

  if (link.state === "recalled") {
    return <Shell brand={brand}><div style={title}>This file was withdrawn</div><div style={muted}>{brand} has withdrawn this link. If you still need the file, please ask them to send it again.</div></Shell>;
  }
  if (link.state === "expired") {
    return <Shell brand={brand}><div style={title}>This link has expired</div><div style={muted}>It stopped working on {formatDateTime(link.expiresAt)}. If you still need the file, please ask {brand} to send it again.</div></Shell>;
  }
  const size = fileSizeLabel(link.sizeBytes);
  return (
    <Shell brand={brand}>
      <div style={{ ...muted, marginBottom: 6 }}>{brand} sent you a file</div>
      <div style={{ ...title, wordBreak: "break-word" }}>{link.fileName}</div>
      {size && <div style={{ ...muted, marginBottom: 18 }}>{size}</div>}
      <form method="post" action={`/api/f/${token}`}>
        <button type="submit" style={{ background: "#ea580c", color: "#fff", border: 0, borderRadius: 8, padding: "12px 22px", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Download</button>
      </form>
      <div style={{ ...muted, marginTop: 18, fontSize: 12 }}>This link works until {formatDateTime(link.expiresAt)}. Please don&apos;t forward it — anyone with the link can open the file.</div>
    </Shell>
  );
}
