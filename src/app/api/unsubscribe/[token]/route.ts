import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";
import { brandForTenant } from "@/lib/tenantBrand";
import { escapeHtml } from "@/lib/escapeHtml";
import { PLATFORM_NAME } from "@/lib/platformIdentity";
import { GOVERNANCE_TX } from "@/lib/audit";

/**
 * MARKETING UNSUBSCRIBE — whose brand, and on which verb.
 *
 * ── The page named one customer to another customer's customers ─────────────
 *
 * The email around this page is fully tenant-aware: `emailBrand()` resolves the
 * logo, display name and origin per tenant, and `buildTrackedEmail` deliberately
 * routes THIS link through the tenant's own hostname — with a comment saying the
 * unsubscribe URL is "the one link a recipient is invited to click when they do
 * not trust the sender". The recipient then landed on a page hard-coded to say
 * "Denago Cape Town". The branding work stopped one hop short of its own goal,
 * at the single most sensitive moment in the message.
 *
 * Unbranded is the platform name, never Denago — the same rule `emailShell`
 * settled on, and for the same reason: a page that cannot identify the sender
 * must name nobody rather than name a stranger.
 *
 * ── The mutation moved off GET ──────────────────────────────────────────────
 *
 * This opted the contact out on `GET`, with no confirmation. Link prefetchers,
 * corporate mail scanners and Safe-Links-style rewriters follow every URL in a
 * message; each one silently unsubscribed a customer who never clicked. The loss
 * is invisible — an opt-out looks identical whoever caused it — and it is not
 * recoverable, because we cannot tell a scanner's opt-out from a real one after
 * the fact.
 *
 * So `GET` renders a confirmation page and writes nothing, and `POST` performs
 * the opt-out. That split is also exactly what RFC 8058 one-click unsubscribe
 * requires, which is why `List-Unsubscribe-Post` could not be sent before this
 * change: the header promises a POST endpoint that did not exist.
 *
 * The POST is deliberately unauthenticated and CSRF-free. A mail provider POSTs
 * it from its own infrastructure with no cookie, no origin and no session — that
 * is the mechanism, not a gap in it. The capability is the token in the path, and
 * the only thing it can do is opt its own contact OUT, which is the direction
 * that is safe to allow a stranger to take. There is no re-subscribe here.
 */

function page(brandName: string, body: string) {
  const safeName = escapeHtml(brandName);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeName}</title></head>
<body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
<div style="max-width:420px;padding:32px;text-align:center;">
<h1 style="font-size:18px;">${safeName}</h1>
${body}
</div></body></html>`;
}

function message(brandName: string, text: string) {
  return page(brandName, `<p style="color:#94a3b8;line-height:1.6;">${escapeHtml(text)}</p>`);
}

function html(markup: string) {
  return new NextResponse(markup, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should sit in a shared cache: the page is per-token and the
      // confirmation must not be served to a later request from a proxy.
      "Cache-Control": "no-store",
    },
  });
}

const INVALID = "This unsubscribe link is no longer valid.";

/**
 * The tenant this token belongs to, for BRANDING, resolved before any scope
 * exists.
 *
 * `withTokenTenantScope` also resolves it, but only when enforcement is on — it
 * is dormant otherwise and runs the work directly. Branding has to be right in
 * both modes, so it is resolved here explicitly. `resolveCampaignRecipientTenant`
 * and `brandForTenant` both read through `basePrisma` by design and neither can
 * throw a request away: the second is documented as never throwing, and the first
 * is a single indexed lookup on a unique column.
 */
async function brandFor(token: string) {
  const owner = await resolveCampaignRecipientTenant(token);
  const brand = await brandForTenant(owner?.tenantId ?? null);
  // The owner is handed back so POST can give withTokenTenantScope the row it
  // already has. One lookup, so the tenant whose name is on the page and the
  // tenant the write commits inside are the same answer rather than two.
  return { owner, known: Boolean(owner), name: brand.displayName };
}

/** Confirmation page. Writes nothing — see the header comment. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let known = false;
  // The platform name until a tenant is resolved, so a lookup that throws still
  // renders a titled page rather than one headed by an empty string.
  let name = PLATFORM_NAME;
  try {
    ({ known, name } = await brandFor(token));
  } catch {
    return html(message(name, "Something went wrong — please reply to the email and we'll remove you."));
  }
  if (!known) return html(message(name, INVALID));
  return html(
    page(
      name,
      `<p style="color:#94a3b8;line-height:1.6;">Stop receiving marketing emails from ${escapeHtml(name)}?</p>
<p style="color:#64748b;font-size:13px;line-height:1.5;">You'll still receive service reminders and messages about your own orders.</p>
<form method="post" action="">
<button type="submit" style="margin-top:12px;padding:12px 20px;font-size:15px;border:0;border-radius:8px;background:#e2e8f0;color:#0f172a;cursor:pointer;">Unsubscribe me</button>
</form>`,
    ),
  );
}

/** Performs the opt-out. Reached by the form above and by RFC 8058 one-click. */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let name = PLATFORM_NAME;
  try {
    const { owner, name: brandName } = await brandFor(token);
    name = brandName;
    // Phase C no-user edge: opt the contact out inside the recipient's tenant scope
    // (dormant no-op when off). Unsubscribe is a COMPLIANCE action, NOT best-effort:
    // the success message is shown ONLY when the opt-out actually committed. An
    // unresolvable tenant under enforcement returns false and keeps the neutral
    // "no longer valid" message — never a false "you've been unsubscribed".
    //
    // The resolver hands back the row brandFor already fetched with
    // resolveCampaignRecipientTenant — the same trusted pre-scope lookup, not a
    // weaker substitute — so a null owner still fails closed here.
    const done = await withTokenTenantScope(
      () => Promise.resolve(owner),
      async () => {
        const r = await prisma.campaignRecipient.findUnique({ where: { token } });
        if (!r) return false;
        // ONE TRANSACTION, because the two writes and the sentence we show are a
        // single claim. Sequentially, a failure on the second left the contact
        // genuinely opted out while the catch below told them it had not worked —
        // so the person is unsubscribed, believes they are not, and the row that
        // would show when it happened is missing. Every later reader disagrees
        // with every other one.
        //
        // The direction of that error is the harmless one for the customer, which
        // is exactly why it would have gone unnoticed: nobody complains about mail
        // they stopped receiving.
        await prisma.$transaction(async (tx) => {
          await tx.contact.update({
            where: { id: r.contactId },
            data: { marketingOptOut: true },
          });
          await tx.campaignRecipient.update({
            where: { id: r.id },
            data: { unsubscribedAt: new Date() },
          });
        }, GOVERNANCE_TX);
        return true;
      },
      () => false,
    );
    return html(
      message(
        name,
        done
          ? `You've been unsubscribed from ${name} marketing emails. You'll still receive service reminders and messages about your own orders.`
          : INVALID,
      ),
    );
  } catch {
    return html(message(name, "Something went wrong — please reply to the email and we'll remove you."));
  }
}
