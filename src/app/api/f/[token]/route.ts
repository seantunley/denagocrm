import { after } from "next/server";
import { logError } from "@/lib/errorLog";
import { throttlePublic } from "@/lib/publicThrottle";
import { SIGNING_READ_POLICY } from "@/lib/rateLimit";
import { downloadFileName, SECURE_LINK_TOKEN } from "@/lib/secureLinks";
import { findSecureLink, recordSecureDownload } from "@/lib/secureLinkStore";
import { openStoredFile } from "@/lib/storage";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSecureFileTenant } from "@/lib/tokenTenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const gone = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The download behind a secure link (lib/secureLinks.ts). Public — the customer
 * has no account — so the link is the whole authority, and this checks it every
 * time: unknown, recalled and expired links get nothing.
 *
 * POST, not GET. Mail gateways and browsers prefetch links with GET; the page
 * at /f/<token> is what a GET reaches, and it hands over no file. Only the
 * button on that page gets here, which is also what makes "downloaded" on the
 * sender's side mean a person asked for it.
 *
 * The file is streamed from our store, read as the link's OWN workspace
 * (openStoredFile refuses a file that belongs to another). The download is
 * recorded after the response: a failed count never costs the customer the file.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!SECURE_LINK_TOKEN.test(token)) return gone(404, "Not found");
  const throttled = await throttlePublic("secure-file", token, SIGNING_READ_POLICY);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSecureFileTenant(token),
    () => download(token),
    () => gone(404, "Not found"),
  );
}

async function download(token: string): Promise<Response> {
  const link = await findSecureLink(token);
  if (!link) return gone(404, "Not found");
  if (link.state === "recalled") return gone(410, "This file was withdrawn by the sender.");
  if (link.state === "expired") return gone(410, "This link has expired.");

  let stream: ReadableStream<Uint8Array>;
  try {
    ({ stream } = await openStoredFile(link.storedRef, link.tenantId));
  } catch (error) {
    await logError("secure-link", error, "the file behind a secure link could not be opened").catch(() => {});
    return gone(404, "This file is no longer available. Please ask the sender to send it again.");
  }

  after(() =>
    withTokenTenantScope(
      async () => ({ tenantId: link.tenantId }),
      () => recordSecureDownload(link),
      () => undefined,
    ).catch((error) => logError("secure-link", error, "a secure-link download could not be recorded").catch(() => {})),
  );

  const name = downloadFileName(link.fileName);
  return new Response(stream, {
    headers: {
      // The type we recorded when it was sent, served as a download — never rendered in the browser.
      "Content-Type": link.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name.ascii}"; filename*=UTF-8''${name.encoded}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
