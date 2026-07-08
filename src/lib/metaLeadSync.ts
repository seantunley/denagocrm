import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
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
  const token = await getSetting("META_PAGE_ACCESS_TOKEN");
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
        const existing = await prisma.lead.findUnique({ where: { externalId: ld.id } });
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
