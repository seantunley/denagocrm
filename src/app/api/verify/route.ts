import { z } from "zod";
import { DOCUMENT_VERIFY_POLICY } from "@/lib/rateLimit";
import { throttlePublic } from "@/lib/publicThrottle";
import { verifySealedDocument } from "@/lib/signing/verifyDocument";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Answers one question for anyone: does this fingerprint belong to a document
 * that was sealed here?
 *
 * Public by design — the person asking is whoever was handed the PDF, and they
 * have no account. What keeps it safe is what it takes and what it gives back:
 *
 *   IN   a SHA-256 and nothing else. The file is fingerprinted in the caller's
 *        browser and is never sent, so a contract is not uploaded to check it.
 *   OUT  for a match: who sealed it, when, the document's title and how many
 *        people signed — all of which is printed in the file the caller already
 *        holds. For anything else: "no match", identically, whether the
 *        fingerprint is unknown, malformed or belongs to an unfinished request.
 *
 * Throttled by address only. The fingerprint is caller-supplied, so keying a
 * limit on it would let anyone mint a row per made-up value (see publicThrottle).
 */
const bodySchema = z.object({ sha256: z.string().regex(/^[0-9a-fA-F]{64}$/) }).strict();

export async function POST(req: Request) {
  const throttled = await throttlePublic("verify-document", null, DOCUMENT_VERIFY_POLICY);
  if (throttled) return throttled;

  // A fingerprint and its JSON wrapper are under a hundred bytes.
  if (Number(req.headers.get("content-length") ?? 0) > 512) {
    return Response.json({ error: "Send the document's SHA-256 fingerprint." }, { status: 400 });
  }
  let json: unknown;
  try {
    json = JSON.parse((await req.text()).slice(0, 512));
  } catch {
    return Response.json({ error: "Send the document's SHA-256 fingerprint." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return Response.json({ error: "Send the document's SHA-256 fingerprint." }, { status: 400 });

  const verdict = await verifySealedDocument(parsed.data.sha256);
  return Response.json(verdict, { headers: { "Cache-Control": "no-store" } });
}
