/**
 * The workspace logo: the tenant's if they have uploaded one, their NAME set as
 * a wordmark if they have not.
 *
 * ONE component for what was fifteen hardcoded `<Image src="/branding/…">` tags.
 * The count is the argument: a convention that says "remember to check the
 * tenant's logo here" gets followed fourteen times out of fifteen, and the
 * fifteenth is a customer looking at another company's mark.
 *
 * ── Why the fallback is TEXT and not a built-in image ───────────────────────
 *
 * It was the built-in Denago asset, and that was wrong in the way that is
 * hardest to argue with: previewing the chain locally showed Acme Golf Carts'
 * login page, correctly reading "Sign in to Acme Golf Carts", underneath the
 * DENAGO CAPE TOWN EV wordmark at full size. An unrecognised hostname did the
 * same. Every string had been neutralised and the single most identifying
 * element on the page had not.
 *
 * That is worse than an unbranded page. A page with no logo says nothing; a page
 * with the WRONG logo tells a tenant's staff whose system they are really on,
 * and tells a stranger who else this platform serves.
 *
 * A neutral replacement IMAGE was the obvious fix and it is the wrong one: it
 * needs artwork nobody has drawn, and until it exists the defect stays open
 * behind a task. The name is already resolved — every caller has it, because it
 * is what `alt` was already being set from — so setting it as a wordmark needs no
 * asset, no design decision, and is what a workspace with no logo should show in
 * any case. It also degrades honestly: a tenant who uploads a logo replaces it,
 * and one who never does looks deliberate rather than broken.
 *
 * The consequence, stated plainly because it is a real one: a tenant with no
 * uploaded logo — INCLUDING the founding one until somebody uploads it in the
 * console — shows a wordmark instead of a picture. That is the same one-time
 * action every other tenant performs, which is the point.
 *
 * Plain `<img>` for an uploaded logo rather than `next/image`: the latter needs
 * intrinsic dimensions and nothing records the dimensions of a file a platform
 * admin uploaded. The `className` bounds it either way.
 */

/** Shared with BrandMark. Split so the two cannot drift apart. */
function Wordmark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap font-semibold uppercase tracking-[0.14em] ${className ?? ""}`}
      // The name is the workspace's own and is bounded at 120 characters on
      // write, but a long one still has to fit a header rather than push the
      // layout sideways — hence nowrap plus the caller's height class.
    >
      {name}
    </span>
  );
}

export default function BrandLogo({
  logoUrl,
  alt,
  className,
  wordmarkClassName,
}: {
  /** The tenant's logo URL, or null to set their name as a wordmark. */
  logoUrl: string | null;
  /** The workspace name. Alt text when there is an image, the wordmark when not. */
  alt: string;
  className?: string;
  /** Type sizing for the wordmark, which cannot inherit an image's height class. */
  wordmarkClassName?: string;
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={alt} className={className} />;
  }
  return <Wordmark name={alt} className={wordmarkClassName ?? "text-base"} />;
}

/**
 * The square mark, for the places that use it instead of the wordmark
 * (KanbanBoard's empty state, the login BrandScene card).
 *
 * A tenant has ONE uploaded logo, not a wordmark and a mark, so it stands in for
 * both. Asking a platform admin for two assets to brand a decorative card is a
 * worse trade than reusing one.
 *
 * With no logo this renders NOTHING rather than a wordmark. Every caller is
 * decorative and every one of them sits beside the workspace name already —
 * repeating it as a graphic would read as a mistake, and the built-in mark has
 * the same problem the wordmark did: it is one customer's.
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
  if (!logoUrl) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logoUrl} alt={alt} className={className} />;
}
