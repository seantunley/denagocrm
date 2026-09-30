// Closes the Settings modal when a link inside it goes anywhere else.
//
// On a client-side navigation a parallel slot KEEPS its last content when the new
// URL doesn't match it; default.tsx only applies on a full page load. So clicking
// a product in Settings → Product catalogue opened /products/[id] UNDERNEATH the
// still-open modal. Matching every other URL here and rendering nothing is Next's
// documented way to close it (parallel-routes.md, "catch-all slot"). The
// (.)settings interceptors are more specific and still win for Settings links.
export default function CloseModal() {
  return null;
}
