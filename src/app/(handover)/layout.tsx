import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";

/**
 * Screens a member of staff hands to a customer on their own device.
 *
 * Deliberately outside the (app) layout: that layout wraps every page in the
 * CRM's navigation, so the customer signing in person had the top bar and the
 * bottom menu around their document — covering part of the form on a phone, and
 * one tap away from the CRM itself. Nothing here renders any of it.
 *
 * Each page still requires its own staff permission; this only repeats the
 * module guard every top-level layout carries.
 */
export default async function HandoverLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await assertPathModuleEnabled();
  return <>{children}</>;
}
