import Image from "next/image";

/**
 * The workspace logo: the tenant's if they have uploaded one, the built-in
 * Denago asset otherwise.
 *
 * ONE component for what was fifteen hardcoded `<Image src="/branding/…">` tags.
 * The count is the argument: a convention that says "remember to check the
 * tenant's logo here" gets followed fourteen times out of fifteen, and the
 * fifteenth is a customer looking at another company's mark.
 *
 * `logoUrl` is threaded in as a prop rather than resolved here, because the
 * resolution differs by surface and only the caller knows which applies — the
 * CRM shell resolves from the SESSION's tenant, the login pages from the
 * HOSTNAME, and print/email from the record being rendered. A component that
 * guessed would be wrong on at least one of them.
 *
 * Plain `<img>` for a tenant logo, `next/image` for the built-in one. That is
 * not an inconsistency: `next/image` needs intrinsic dimensions, the built-in
 * asset has known ones, and an uploaded logo does not — nothing records the
 * dimensions of a file a platform admin uploaded. The `className` bounds both.
 */
export default function BrandLogo({
  logoUrl,
  alt,
  className,
  priority,
}: {
  /** The tenant's logo URL, or null to render the built-in asset. */
  logoUrl: string | null;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={alt} className={className} />;
  }
  return (
    <Image
      src="/branding/denago-cape-town-logo.png"
      alt={alt}
      width={230}
      height={58}
      priority={priority}
      className={className}
    />
  );
}

/**
 * The square mark, for the places that use it instead of the wordmark
 * (KanbanBoard's empty state, the login BrandScene card).
 *
 * A tenant has ONE uploaded logo, not a wordmark and a mark, so it stands in for
 * both. Asking a platform admin for two assets to brand a decorative card is a
 * worse trade than reusing one.
 */
export function BrandMark({
  logoUrl,
  alt,
  className,
}: {
  logoUrl: string | null;
  alt: string;
  className?: string;
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={alt} className={className} />;
  }
  return <Image src="/branding/denago-mark.png" alt={alt} width={68} height={68} className={className} />;
}
