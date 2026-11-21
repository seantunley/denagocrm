import { NextRequest, NextResponse } from "next/server";
import { logError } from "@/lib/errorLog";
import { contactCardFor } from "@/lib/contactCardServer";
import { contactCardFileName } from "@/lib/contactCard";

export const runtime = "nodejs";

/**
 * "Save my contact" (lib/contactCard.ts): the person's contact card, from the link in their email signature. Public — a
 * customer's phone opens it — so the token is signed and the card is only what their signature already shows. A phone
 * opens a .vcf in its contacts app ("Add contact"). Anything wrong, or a card no longer offered, is a plain 404.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const card = await contactCardFor(token).catch(async (error) => {
    await logError("contact-card", error, "a contact card could not be built").catch(() => {});
    return null;
  });
  if (!card) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const file = contactCardFileName(card.name);
  return new NextResponse(card.vcf, {
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      // inline: iPhone shows the card with "Create new contact"; Android hands the file to Contacts.
      "Content-Disposition": `inline; filename="${file.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(file)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
