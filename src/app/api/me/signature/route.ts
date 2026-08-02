import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { directReadUrl, readFile } from "@/lib/storage";

/**
 * The signed-in user's own saved countersignature, as an image.
 *
 * The pad needs to SHOW what "Sign as Denago" is about to stamp on the quote,
 * and it cannot link to the stored ref: saveFile() returns a Vercel Blob URL in
 * production but a bare filename on local disk, so there is no one ref the
 * browser can load — and handing a stored ref to an <img src> is the shape
 * storage.ts already warns about.
 *
 * So this route takes no ref at all. It resolves the CALLER'S OWN signature
 * from the session, which means there is nothing in the URL to point at someone
 * else's, and nothing to leak if the URL is shared.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { drawnSignatureRef: true },
  });
  if (!me?.drawnSignatureRef) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Signatures written before the private store are public Blob objects the
  // browser can fetch itself. Proxying them meant readFile() asking the Blob API
  // to prove ownership, which needs a token — so on any machine without one the
  // preview 404'd and the pad showed nothing.
  const direct = directReadUrl(me.drawnSignatureRef);
  if (direct) return NextResponse.redirect(direct);

  try {
    const buffer = await readFile(me.drawnSignatureRef);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        // signAsDealer only ever stores `data:image/png;base64,…`, so the type
        // is known rather than sniffed.
        "Content-Type": "image/png",
        "Content-Length": String(buffer.length),
        "X-Content-Type-Options": "nosniff",
        // Personal, and replaced whenever they draw a new one.
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
