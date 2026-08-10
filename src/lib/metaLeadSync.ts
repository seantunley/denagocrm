import { basePrisma } from "@/lib/db";
import { resolveTenantCredential } from "@/lib/settings";
import { currentTenantScope } from "@/lib/tenantScope";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { createIntakeLead } from "@/lib/leadIntake";
import { parseLeadFields, metaSource, type FieldData } from "@/lib/metaLead";

const G = "https://graph.facebook.com/v21.0";

/**
 * Polling fallback for Facebook Lead Ads: pulls leads straight from the
 * page's forms via the Graph API. Catches anything the webhook missed
 * (Meta delivery is flaky in dev mode) — dedupe on externalId means the
 * two paths never double-create.
 */
export async function syncFacebookLeads(): Promise<number> {
  const tenantId = currentTenantScope()?.tenantId ?? null;
  const token = await resolveTenantCredential(tenantId, "META_PAGE_ACCESS_TOKEN");
  if (!token) return 0;

  const pagesRes = await fetch(
    `${G}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`,
    { cache: "no-store", signal: AbortSignal.timeout(10000) }
  );
  if (!pagesRes.ok) throw new Error(`me/accounts ${pagesRes.status}`);
  const pages: { data?: { id: string; name: string; access_token: string }[] } =
    await pagesRes.json();

  let created = 0;
  for (const page of pages.data ?? []) {
    const formsRes = await fetch(
      `${G}/${page.id}/leadgen_forms?fields=id,name,status&limit=25&access_token=${encodeURIComponent(page.access_token)}`,
      { cache: "no-store", signal: AbortSignal.timeout(10000) }
    );
    if (!formsRes.ok) continue;
    const forms: { data?: { id: string; status: string }[] } = await formsRes.json();

    for (const form of forms.data ?? []) {
      const leadsRes = await fetch(
        `${G}/${form.id}/leads?fields=id,created_time,field_data,ad_name,platform&limit=100&access_token=${encodeURIComponent(page.access_token)}`,
        { cache: "no-store", signal: AbortSignal.timeout(10000) }
      );
      if (!leadsRes.ok) continue;
      const leads: {
        data?: {
          id: string;
          created_time: string;
          field_data?: FieldData[];
          ad_name?: string;
          platform?: string;
        }[];
      } = await leadsRes.json();

      for (const ld of leads.data ?? []) {
        // basePrisma, NOT prisma: the dedupe must see SOFT-DELETED leads too.
        //
        // `externalId` is unique at the DATABASE level regardless of deletedAt, but
        // the soft-delete extension hides deleted rows from the guarded client. So
        // once someone deleted a Meta lead, this lookup returned null, the sync
        // tried to re-create it, and the unique index rejected the insert — every
        // 15 minutes, for ever. On production that was 692 logged failures from
        // four deleted leads, drowning the error log in noise that looked like a
        // Meta problem and was really "a user deleted a lead".
        //
        // Deleting a lead means "I do not want this", so the right behaviour is to
        // treat it as already synced and skip it — never to resurrect it.
        // Scoped to this tenant: a Meta leadgen id is unique to Meta, not to us, so
        // another tenant holding the same id must not make us skip this one.
        const existing = await basePrisma.lead.findFirst({
          where: { externalId: ld.id, tenantId: currentTenantScope()?.tenantId ?? DEFAULT_TENANT_ID },
          select: { id: true },
        });
        if (existing) continue;
        const parsed = parseLeadFields(ld.field_data ?? []);
        await createIntakeLead({
          name: parsed.name ?? "New lead",
          email: parsed.email,
          phone: parsed.phone,
          model: parsed.model,
          color: parsed.color,
          message: parsed.message,
          source: metaSource(ld.platform),
          externalId: ld.id,
          raw: ld,
        });
        created++;
      }
    }
  }
  return created;
}
