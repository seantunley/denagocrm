import type { Metadata } from "next";
import { BrandStyle, loginBrand } from "@/lib/loginBrand";
import { VerifyDocument } from "./VerifyDocument";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check a signed document", robots: { index: false } };

/**
 * "Is this the document that was signed?" — for whoever was handed the PDF.
 *
 * Public, like the signing pages: the person asking has no account. The brand
 * comes from the hostname, the way the login pages take it, because until a
 * file matches there is nothing else to say whose page this is.
 *
 * The checking happens in VerifyDocument (the file is fingerprinted in the
 * browser and never uploaded) and in /api/verify (which only ever sees the
 * fingerprint).
 */
export default async function VerifyPage() {
  const brand = await loginBrand();
  return (
    <div style={{ minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", display: "flex", flexDirection: "column", alignItems: "center", padding: "40px 16px", fontFamily: "Helvetica, Arial, sans-serif" }}>
      <BrandStyle brand={brand} />
      {brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logoUrl} alt={brand.displayName} style={{ marginBottom: 20, height: 32, width: "auto" }} />
      ) : brand.branded ? (
        <div style={{ marginBottom: 20, fontWeight: 800, letterSpacing: 1, color: "#fff" }}>{brand.displayName}</div>
      ) : null}
      <VerifyDocument />
    </div>
  );
}
