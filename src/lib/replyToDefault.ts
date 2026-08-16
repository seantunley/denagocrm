import "server-only";
import { resolveIntegrationBundle } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { defaultReplyTo } from "./replyToAddresses";

/**
 * The `Reply-To` the composer opens with: the sender, then the CRM's mailbox.
 *
 * The CRM's mailbox is whatever IMAP is configured to READ, because that is the
 * address whose replies reach the timeline. Resolved through
 * `resolveIntegrationBundle` — the same path `imapSync` uses — so a workspace with
 * its own mail credentials gets its own address rather than the platform's, which
 * is the whole point of that resolver existing.
 *
 * NEVER THROWS. This decorates a composer with a default somebody can edit or
 * clear. A settings lookup that raised here would take down the lead and contact
 * pages that render the composer, for a pre-filled field — the same trade
 * `emailBrand` makes for the campaign shell, and for the same reason.
 *
 * An empty string is a real answer: no IMAP configured and no address on the user
 * record means there is nothing to suggest, and the field opens blank. Mail then
 * behaves exactly as it did before this feature — replies go to the From address.
 */
export async function composerReplyToDefault(senderEmail: string | null | undefined): Promise<string> {
  let crmMailbox: string | null = null;
  try {
    const tenantId = currentTenantScope()?.tenantId ?? null;
    const bundle = await resolveIntegrationBundle(tenantId, "imap");
    // `IMAP_USER` is a LOGIN, and not every server wants an address for one.
    // `defaultReplyTo` drops it unless it looks like an address — putting a bare
    // username in Reply-To would produce mail whose replies bounce.
    crmMailbox = bundle?.IMAP_USER ?? null;
  } catch {
    crmMailbox = null;
  }
  return defaultReplyTo({ senderEmail, crmMailbox });
}
