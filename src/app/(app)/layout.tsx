import { redirect } from "next/navigation";
import { requireUser, getActiveTenantId, isTenantOwner } from "@/lib/auth";
import type { Metadata } from "next";
import { brandForTenant, brandIcons, brandLogoUrl, brandStyle, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { getSetting } from "@/lib/settings";
import { WEATHER_CITIES_KEY, parseWeatherCities } from "@/lib/weatherCities";
import { ACTIVITY_TYPES_KEY, activityTypesForModules, resolveActivityTypes } from "@/lib/activityTypes";
import { awaitingReplyCount } from "@/lib/inboxCount";
import { casesAwaitingCount } from "@/lib/helpdesk";
import { getUserPermissionList } from "@/lib/permissions";
import { getEnabledModuleIds } from "@/lib/modules/enabled";
import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { currentTenantScope } from "@/lib/tenantScope";
import AppShell from "@/components/AppShell";
import AppContextMenu from "@/components/AppContextMenu";
import SessionKeeper from "@/components/SessionKeeper";
import AssistantBubble from "@/components/AssistantBubble";
import { prisma } from "@/lib/db";

/**
 * Tab title and icon from the SESSION's workspace. The root layout can only go
 * by hostname, so a workspace's staff working on the platform's own domain saw
 * the platform's name and icon. Never throws: on any failure the root's
 * hostname answer stands.
 */
export async function generateMetadata(): Promise<Metadata> {
  try {
    const brand = await brandForTenant(await getActiveTenantId());
    if (!brand.tenantId) return {};
    return { title: brand.displayName, icons: brandIcons(brand) };
  } catch {
    return {};
  }
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

  // The workspace's activity types, resolved HERE for the same reason: the type
  // pickers are client components scattered across the app, and none of them can
  // reach the tenant. `resolveActivityTypes` is total — an unreadable setting
  // gives the built-in seven rather than an empty picker.
  // Module-only built-ins (a test drive needs the automotive module) are hidden
  // where the module is off. If the module lookup failed, nothing is hidden.
  const storedTypes = resolveActivityTypes(await getSetting(ACTIVITY_TYPES_KEY));
  const activityTypes = enabledModules ? activityTypesForModules(storedTypes, enabledModules) : storedTypes;


  // The accent override, or nothing. `brandStyle` returns null for an unbranded
  // tenant, so this renders NO element and the shell is byte-for-byte what it was
  // — the app's own --primary from globals.css stands. One custom property is all
  // it takes because the whole UI is tokenised (~75 properties mapped into
  // Tailwind via @theme inline), which is why the roadmap chose "accent + logo"
  // as the depth: components consume tokens, not literal colours.
  const style = brandStyle(brand);

  // The floating "Ask" bubble: the same gate as the /assistant page and its
  // actions — the Automation & AI module, and a lead/quote/activity view grant.
  const ASSISTANT_GRANTS = ["leads.view_all", "leads.view_owned", "quotes.view_all", "quotes.view_owned", "activities.view", "activities.manage"];
  const showAssistant =
    (enabledModules === null || enabledModules.has("automation")) &&
    (user.role === "owner" || permissions.some((p) => ASSISTANT_GRANTS.includes(p)));
  // Scheduled answers and watch notes this person hasn't seen yet → the
  // bubble's unread dot. Counted HERE so the bubble itself still fetches
  // nothing until it's opened; one indexed count of their own turns, and only
  // when the bubble shows.
  const assistantUnseen = showAssistant
    ? await prisma.assistantTurn.count({ where: { userId: user.id, source: { in: ["schedule", "watch"] }, seenAt: null } }).catch(() => 0)
    : 0;

  return (
    <>
      {style && <style>{style}</style>}
      {/* The app's right-click menu. Mounted once here rather than per page: it
          listens on `document` and stands aside wherever RecordContextMenu, a
          flow canvas or a text input has already claimed the click. */}
      <AppContextMenu />
      <SessionKeeper />
      {/* Resolved here, in the SERVER layout, for the same reason `brand` is:
          getSetting reads the tenant from the request scope, which a client
          component has no access to. */}
      <AppShell
        user={{
          id: user.id,
          name: user.name,
          role: user.role,
          // The workspace's own owner (Tenant.ownerUserId) or the platform owner —
          // what the nav and menus mean by "owner". Never throws: false on failure.
          isTenantOwner: await isTenantOwner().catch(() => false),
          permissions,
          avatarVersion: user.avatarRef ? user.avatarUpdatedAt?.toISOString() ?? "current" : null,
        }}
        inboxWaiting={inboxWaiting}
        casesWaiting={casesWaiting}
        enabledModules={enabledModules ? [...enabledModules] : undefined}
        brand={{ logoUrl: brandLogoUrl(brand), displayName: brand.displayName }}
        weatherCities={weatherCities}
        activityTypes={activityTypes}
        tenantId={activeTenantId ?? ""}
      >
        {children}
        {modal}
      </AppShell>
      {showAssistant && <AssistantBubble unseen={assistantUnseen} />}
    </>
  );
}
