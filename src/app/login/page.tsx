import type { Metadata, Viewport } from "next";
import { BrandStyle, loginBrand, loginMetadata, signInWorkspaceFrom, type SignInSearch } from "@/lib/loginBrand";
import LoginClient from "./LoginClient";

/**
 * Edge to edge on notched phones, so the page's env(safe-area-inset-*) padding
 * is real (it is 0 without this). Only this route: the app's own screens were
 * not built to sit under the notch.
 */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

/** A workspace's own sign-in link (?w=) carries its name and icon to the tab too. Cannot throw. */
export async function generateMetadata({ searchParams }: { searchParams: SignInSearch }): Promise<Metadata> {
  return loginMetadata(await signInWorkspaceFrom(searchParams));
}

/**
 * Staff sign-in.
 *
 * A SERVER component wrapping the client one, for a single reason: the brand is
 * decided by the hostname the request arrived on (or, on an address no workspace
 * owns, the workspace its sign-in link names), and only a server component can
 * read `headers()`. The interactive half — `useActionState`, the passkey button,
 * `useSearchParams`, the framer-motion scene — is untouched in LoginClient.tsx.
 *
 * `loginBrand()` cannot throw. That is deliberate and it is the whole risk
 * calculation for this file: a sign-in page that errors locks every user out of
 * the workspace, and no accent colour is worth that. Its worst case is
 * `UNBRANDED`, which renders exactly what this page rendered before.
 */
export default async function LoginPage({ searchParams }: { searchParams: SignInSearch }) {
  const brand = await loginBrand(await signInWorkspaceFrom(searchParams));
  return (
    <>
      <BrandStyle brand={brand} />
      <LoginClient brand={brand} />
    </>
  );
}
