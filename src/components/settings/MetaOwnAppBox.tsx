import { basePrisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/campaigns";
import { workspaceMetaCallbackUrl } from "@/lib/metaWorkspaceApp";

/**
 * Settings → Integrations → Meta: this workspace's OWN Meta app (Sean, 2026-11-21: "Each workspace will have its
 * own"). The address its app delivers to — this workspace's own, checked with the secret and verify token saved in
 * the fields below — and what to subscribe, so Instagram comments, DMs and Page events all arrive.
 */
export default async function MetaOwnAppBox({ tenantId }: { tenantId: string }) {
  // basePrisma, by this workspace's id: the slug is its own, read for its own owner.
  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) return null;
  return (
    <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
      <p className="text-sm font-medium">This workspace&apos;s own Meta app</p>
      <p className="mt-1 text-xs text-muted-foreground">
        In your Meta app → Webhooks, set this callback URL and the verify token you save below, then subscribe{" "}
        <b>Instagram</b> to <b>messages</b> and <b>comments</b>, and your <b>Page</b> to <b>messages</b>, <b>feed</b> and{" "}
        <b>leadgen</b>. Save your app&apos;s secret below too: every delivery is checked with it, and only reaches this
        workspace. Leave both blank if this workspace doesn&apos;t use its own Meta app.
      </p>
      <label className="label mt-3">Callback URL</label>
      <code className="block break-all rounded-lg bg-muted px-3 py-2 text-sm">{workspaceMetaCallbackUrl(appBaseUrl(), tenant.slug)}</code>
    </div>
  );
}
