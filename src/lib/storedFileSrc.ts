/**
 * The link a BROWSER uses to show or open a stored file.
 *
 * Files in the private store have no public URL, so a stored ref can't be put in
 * an <img>, <audio>, <video> or <a> as it is. Our own files go through
 * /api/stored, which checks the viewer is signed in to the workspace that owns
 * the file and streams it. Anything else — an outside link, a `data:` image, a
 * local `blob:` preview — is returned untouched.
 *
 * Pure and dependency-free, so client components can use it. The route does
 * the real checks; this only decides which links go through it.
 */
const OUR_BLOB = /^https:\/\/[a-z0-9-]+(\.private|\.public)?\.blob\.vercel-storage\.com\//i;
/** A bare local upload name (dev only): no slash, no scheme. */
const LOCAL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function storedFileSrc(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (OUR_BLOB.test(ref) || LOCAL_REF.test(ref)) return `/api/stored?ref=${encodeURIComponent(ref)}`;
  return ref;
}
