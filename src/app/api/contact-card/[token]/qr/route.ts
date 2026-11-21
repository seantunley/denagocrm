import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/errorLog";
import { contactCardFor, contactCardPath, contactQrPng } from "@/lib/contactCardServer";

export const runtime = "nodejs";

/**
 * The QR code beside "Save my contact": for a customer reading on a computer, who scans it with their phone. Public,
 * like the card. Emails from the CRM carry the picture inside them (lib/emailInlineLogo.ts); a signature pasted into
 * Gmail or Outlook links here. Served only while the owner's choice is "link and QR code".
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const card = await contactCardFor(token);
    if (card?.design.contactCard === "qr") {
      const png = await contactQrPng(new URL(contactCardPath(token), req.nextUrl.origin).href);
      return new NextResponse(new Uint8Array(png), {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" },
      });
    }
  } catch (error) {
    await logError("contact-card", error, "a contact card QR code could not be drawn").catch(() => {});
  }
  return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
