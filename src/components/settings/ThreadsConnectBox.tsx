import { basePrisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/campaigns";

/** What Connect Threads came back with (?threads=…), in words. */
const NOTICES: Record<string, string> = {
  connected: "Threads is connected.",
  "missing-app": "Enter your Threads app ID and secret below first, then press Connect Threads.",
  denied: "Threads sign-in was cancelled.",
  invalid: "That Threads sign-in could not be read — please try again.",
  "in-use": "That Threads account is already connected to another workspace, so nothing was connected.",
  failed: "Threads sign-in could not be completed. Check the redirect URI in your Threads app matches this CRM's address, then try again.",
};

/**
 * Settings → Integrations → Threads (Sean, 2026-11-21): this workspace's own Threads app. Where its webhook delivers
 * (this workspace's own address — signed with its app secret, only ever for its own Threads account), what to
 * subscribe, and Connect Threads.
 */
export default async function ThreadsConnectBox({ tenantId, connected, notice }: { tenantId: string; connected: boolean; notice?: string | null }) {
  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) return null;
  const base = appBaseUrl();
  const message = notice ? NOTICES[notice] : null;
  return (
    <div className="mb-5 rounded-lg border border-border bg-background/40 p-4">
      <p className="text-sm font-medium">{connected ? "Threads is connected" : "Connect your Threads account"}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        In your Meta app (Threads use case): add the redirect URI below under Threads → Settings, set the callback URL and
        the verify token you save below under Webhooks, and subscribe to <b>replies</b>. Save the app ID and secret below,
        then press Connect Threads. Threads has no direct messages — comments are answered publicly, or hidden.
      </p>
      {message && <p className="mt-2 text-xs text-amber-300">{message}</p>}
      <label className="label mt-3">Redirect URI</label>
      <code className="block break-all rounded-lg bg-muted px-3 py-2 text-sm">{`${base}/api/integrations/threads/callback`}</code>
      <label className="label mt-3">Webhook callback URL</label>
      <code className="block break-all rounded-lg bg-muted px-3 py-2 text-sm">{`${base}/api/webhooks/threads?workspace=${encodeURIComponent(tenant.slug)}`}</code>
      <a href="/api/integrations/threads/connect" className="btn-primary btn-sm mt-3 inline-flex">
        {connected ? "Reconnect Threads" : "Connect Threads"}
      </a>
    </div>
  );
}
