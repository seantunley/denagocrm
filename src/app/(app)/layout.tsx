import { redirect } from "next/navigation";
import { getActiveTenantId, requireUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { brandForTenant, brandLogoUrl, brandStyle, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { getSetting } from "@/lib/settings";
import { WEATHER_CITIES_KEY, parseWeatherCities } from "@/lib/weatherCities";
import { awaitingReplyCount } from "@/lib/inboxCount";
import { casesAwaitingCount } from "@/lib/helpdesk";
import { getUserPermissionList } from "@/lib/permissions";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { currentTenantScope } from "@/lib/tenantScope";
import AppShell from "@/components/AppShell";
import AppContextMenu from "@/components/AppContextMenu";
import OfflineProvider from "@/components/OfflineProvider";

/**
 * The offline outbox, when there is a workspace to key it by.
 *
 * Written as a component rather than inlined so the children are built ONCE.
 * Duplicating the whole <AppShell> tree across both arms of a ternary is how the
 * two copies drift, and one of them is only ever rendered by the sessions
 * nobody tests with.
 */
function MaybeOffline({
  tenantId,
  userId,
  children,
}: {
  tenantId: string | null;
  userId: string;
  children: React.ReactNode;
}) {
  if (!tenantId) return <>{children}</>;
  return (
    <OfflineProvider tenantId={tenantId} userId={userId}>
      {children}
    </OfflineProvider>
  );
}

export default async function AppLayout({
  children,
  modal,
}: Readonly<{ children: React.ReactNode; modal?: React.ReactNode }>) {
  const user = await requireUser();

  // Owner lockout escape hatch (DORMANT off): under enforcement, an owner whose
  // request resolved NO active tenant scope (establishStaffTenantScope granted the
  // owner no scope, on purpose) must land on the platform console to fix their
  // tenancy — not this fail-closed CRM shell, whose tenant-scoped reads below would
  // all throw. Non-owners can't reach here in that state: they'd have failed auth
  // (ok:false) and requireUser would already have redirected to /login. The whole
  // branch is inert while enforcement is off, so behaviour is unchanged.
  if (tenantEnforcing() && user.role === "owner" && !currentTenantScope()?.tenantId) {
    redirect("/platform/tenants");
  }

  const activeTenantId = await getActiveTenantId();
  const [inboxWaiting, casesWaiting, permissions, enabledModules, brand] = await Promise.all([
    awaitingReplyCount(user).catch(() => 0),
    casesAwaitingCount(user).catch(() => 0),
    getUserPermissionList(user),
    getEnabledModuleIds().catch(() => null),
    // Brand from the SESSION's tenant, not the hostname — the login pages resolve
    // by hostname because they have nothing else, but inside the app the tenant is
    // already known, and a staff member reaching the CRM on the platform's own
    // domain must still see their own brand. brandForTenant never throws; this
    // layout wraps every page in the workspace.
    brandForTenant(activeTenantId).catch(() => DEFAULT_BRAND),
  ]);

  // Single-point route block: a page belonging to a disabled module is not
  // reachable by direct URL, not just hidden from the nav. Shared with the
  // /messages PWA and (print) layouts via the routeGuard helper.
  await assertPathModuleEnabled();

  // The tenant's clock/weather cities. Resolved HERE, in the server layout,

  // for the same reason `brand` is: getSetting reads the tenant from the

  // request scope, which a client component cannot reach. Falls back to the

  // default when unset or unreadable - this renders on every signed-in page

  // and must not be able to break one.

  const weatherCities = parseWeatherCities(await getSetting(WEATHER_CITIES_KEY));


  // The accent override, or nothing. `brandStyle` returns null for an unbranded
  // tenant, so this renders NO element and the shell is byte-for-byte what it was
  // — the app's own --primary from globals.css stands. One custom property is all
  // it takes because the whole UI is tokenised (~75 properties mapped into
  // Tailwind via @theme inline), which is why the roadmap chose "accent + logo"
  // as the depth: components consume tokens, not literal colours.
  const style = brandStyle(brand);

  return (
    <>
      {style && <style>{style}</style>}
      {/* The app's right-click menu. Mounted once here rather than per page: it
          listens on `document` and stands aside wherever RecordContextMenu, a
          flow canvas or a text input has already claimed the click. */}
      <AppContextMenu />
      {/* Resolved here, in the SERVER layout, for the same reason `brand` is:
          getSetting reads the tenant from the request scope, which a client
          component has no access to. */}
      {/*
        The shell renders either way. Without a resolvable tenant there is no
        partition to store offline work in, so the provider is omitted rather
        than handed an empty key that would collide with every other tenantless
        session on the device.
      */}
      <MaybeOffline tenantId={activeTenantId} userId={user.id}>
        <AppShell
          user={{
            id: user.id,
            name: user.name,
            role: user.role,
            permissions,
            avatarVersion: user.avatarRef ? user.avatarUpdatedAt?.toISOString() ?? "current" : null,
          }}
          inboxWaiting={inboxWaiting}
          casesWaiting={casesWaiting}
          enabledModules={enabledModules ? [...enabledModules] : undefined}
          brand={{ logoUrl: brandLogoUrl(brand), displayName: brand.displayName }}
          weatherCities={weatherCities}
          // AppShell needs a tenant for the checklist device store; the offline
          // outbox needs one for its partition. Same value, and the empty string
          // is what the tenantless dormant session already gets elsewhere.
          tenantId={activeTenantId ?? ""}
        >
          {children}
          {modal}
        </AppShell>
      </MaybeOffline>
    </>
  );
}
