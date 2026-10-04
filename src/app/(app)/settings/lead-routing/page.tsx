import { requireTenantOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { listActingTenantStaff } from "@/lib/tenantActor";
import { LEAD_ROUTING_KEY, parseLeadRoutingConfig } from "@/lib/leadRouting";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import LeadRoutingSettings from "@/components/settings/LeadRoutingSettings";

export const dynamic = "force-dynamic";

/**
 * Auto-assignment of new inbound leads (lib/leadRouting.ts).
 *
 * `requireTenantOwner` here as well as in `saveLeadRouting`: the action protects
 * the write; this stops a member being shown a page whose every control would
 * refuse them. The people offered are `listActingTenantStaff` — the same list the
 * action validates against, so the picker cannot offer someone the save refuses.
 */
export default async function LeadRoutingSettingsPage() {
  await requireTenantOwner();
  const [raw, staff, products, sources] = await Promise.all([
    getSetting(LEAD_ROUTING_KEY),
    listActingTenantStaff(),
    prisma.product.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // Sources this workspace's leads actually carry, as suggestions for a rule —
    // a source is free text on the lead, so a fixed list would miss some.
    prisma.lead.findMany({ distinct: ["source"], select: { source: true }, take: 50 }),
  ]);

  return (
    <SettingsWorkspace
      current="lead-routing"
      title="Lead routing"
      description="Automatically assign new leads from your website, Facebook, Instagram, WhatsApp and chatbot to a rep. Leads your team creates by hand are not affected."
      groups={SETTINGS_NAV_GROUPS}
    >
      <LeadRoutingSettings
        initial={parseLeadRoutingConfig(raw)}
        staff={staff.map(({ id, name }) => ({ id, name }))}
        products={products}
        sources={sources.map((row) => row.source).filter(Boolean).sort()}
      />
    </SettingsWorkspace>
  );
}
