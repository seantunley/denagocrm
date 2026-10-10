import type { LoginBrand } from "@/lib/loginBrand";
import { Toaster } from "@/components/ui/sonner";

/**
 * The frame every signing screen sits in — the customer's own link, and the
 * in-person screen a member of staff hands over. One definition, so the customer
 * sees the same thing whichever way the document reached them, and neither can
 * pick up the CRM's own navigation.
 */
export function SigningShell({ children, brand }: { children: React.ReactNode; brand?: LoginBrand }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      {brand?.style && <style>{brand.style}</style>}
      {brand?.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoUrl} alt={brand.displayName} style={{ marginBottom: 20, height: 32, width: "auto" }} />
      ) : brand?.branded ? (
        <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff" }}>{brand.displayName}</div>
      ) : null}
      {children}
      {/* Signing has no layout of its own, so the Toaster is mounted on this
          shell. Feedback matters most here: the signer is an outside party with
          no other way to tell whether their signature was recorded. */}
      <Toaster />
    </div>
  );
}

/** A signing screen that is only a message: nothing to read, fill in or sign. */
export function SigningMessage({ title, body, brand, children }: { title: string; body: string; brand?: LoginBrand; children?: React.ReactNode }) {
  return (
    <SigningShell brand={brand}>
      <div style={{ maxWidth: 460, background: "#1e293b", border: "1px solid #334155", borderRadius: 12, padding: 28, textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, color: "#94a3b8", lineHeight: 1.55 }}>{body}</div>
        {children}
      </div>
    </SigningShell>
  );
}
