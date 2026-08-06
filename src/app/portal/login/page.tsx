import { BrandStyle, loginBrand } from "@/lib/loginBrand";
import PortalLoginClient from "./PortalLoginClient";

/**
 * Customer portal sign-in.
 *
 * Same shape as the staff login, and the same reason: the brand comes from the
 * hostname, and only a server component can read `headers()`. The OTP flow —
 * both `useActionState` forms, the resend timer, the step indicator — is
 * untouched in PortalLoginClient.tsx.
 *
 * This is the page that matters most for white-label. It is what a tenant's
 * CUSTOMERS see, and a customer greeted by another company's name has been given
 * a reason to doubt where they just typed their email address.
 */
export default async function PortalLoginPage() {
  const brand = await loginBrand();
  return (
    <>
      <BrandStyle brand={brand} />
      <PortalLoginClient brand={brand} />
    </>
  );
}
