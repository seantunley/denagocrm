import { BrandStyle, loginBrand } from "@/lib/loginBrand";
import LoginClient from "./LoginClient";

/**
 * Staff sign-in.
 *
 * A SERVER component wrapping the client one, for a single reason: the brand is
 * decided by the hostname the request arrived on, and only a server component
 * can read `headers()`. The interactive half — `useActionState`, the passkey
 * button, `useSearchParams`, the framer-motion scene — is untouched in
 * LoginClient.tsx; it now takes a `brand` prop and nothing else changed.
 *
 * `loginBrand()` cannot throw. That is deliberate and it is the whole risk
 * calculation for this file: a sign-in page that errors locks every user out of
 * the workspace, and no accent colour is worth that. Its worst case is
 * `UNBRANDED`, which renders exactly what this page rendered before.
 */
export default async function LoginPage() {
  const brand = await loginBrand();
  return (
    <>
      <BrandStyle brand={brand} />
      <LoginClient brand={brand} />
    </>
  );
}
