const FOOTER_MARKER = '<div class="doc-footer">';
const PRINT_FOOTER_MARKER = '<div class="doc-footer doc-footer-print">';
const SCREEN_FOOTER_MARKER = '<div class="doc-footer-screen">';
const PAGE_MARKER = '<div class="doc-page"';
const CLOSE_DIV = '</div>';

/**
 * Keep the printable fixed footer exactly where the shared document renderer puts
 * it, but render a second SCREEN-ONLY copy inside the final quote sheet.
 *
 * The shared serializer deliberately emits document footers as a sibling after
 * the pages because, in print, `.doc-footer { position: fixed }` repeats that
 * region on every physical sheet. On screen, however, the same sibling is no
 * longer part of the white `.doc-page`, so even when its top edge touches the
 * page it still reads as content on the blue application canvas.
 *
 * Quotes need the screen representation to match the paper: the footer belongs
 * inside the final white sheet. We therefore duplicate only that footer region:
 *
 *   screen -> clone lives inside the final `.doc-page`; fixed sibling is hidden
 *   print  -> clone is hidden; the original fixed footer is untouched
 *
 * A quote whose footer is already a normal block inside its page has no
 * `.doc-footer` region, so this function returns the HTML byte-for-byte unchanged.
 */
export function attachQuoteFooterToFinalScreenSheet(html: string): string {
  // Idempotent: callers may safely pass already-adjusted HTML through again.
  if (html.includes(SCREEN_FOOTER_MARKER) || html.includes(PRINT_FOOTER_MARKER)) return html;

  const bodyEnd = html.lastIndexOf('</body>');
  const footerStart = html.lastIndexOf(FOOTER_MARKER, bodyEnd);
  if (bodyEnd < 0 || footerStart < 0) return html;

  // The shared serializer emits the document footer as the final body child, with
  // no whitespace after it. Its last closing div is therefore the wrapper close.
  const footerClose = html.lastIndexOf(CLOSE_DIV, bodyEnd);
  if (footerClose < footerStart) return html;

  const pageStart = html.lastIndexOf(PAGE_MARKER, footerStart);
  if (pageStart < 0) return html;

  // The footer immediately follows the final page in the serializer. The final
  // closing div before the footer marker is therefore the final page's own close.
  const pageClose = html.lastIndexOf(CLOSE_DIV, footerStart);
  if (pageClose < pageStart) return html;

  const styleEnd = html.lastIndexOf('</style>', pageStart);
  if (styleEnd < 0) return html;

  const footerInner = html.slice(footerStart + FOOTER_MARKER.length, footerClose);
  const screenFooter = `${SCREEN_FOOTER_MARKER}${footerInner}${CLOSE_DIV}`;
  const printFooter = `${PRINT_FOOTER_MARKER}${footerInner}${CLOSE_DIV}`;

  // First move a visual copy INSIDE the final page while preserving the original
  // page close. Then replace the original sibling with the print-only copy.
  let next =
    html.slice(0, pageClose) +
    screenFooter +
    html.slice(pageClose, footerStart) +
    printFooter +
    html.slice(footerClose + CLOSE_DIV.length);

  // Do not change the shared serializer's print rule. The original `.doc-footer`
  // still receives `position: fixed`; these rules only decide which copy is visible
  // in which medium. `flow-root` contains the footer block's own vertical margin so
  // it cannot collapse out of the final sheet again.
  const mediaRules = `
    @media screen {
      .doc-footer-print { display: none !important; }
      .doc-footer-screen { display: flow-root; width: 100%; }
    }
    @media print {
      .doc-footer-screen { display: none !important; }
    }
  `;

  // `styleEnd` was measured before the footer insertion, which occurs after
  // </style>, so its offset is still valid.
  next = next.slice(0, styleEnd) + mediaRules + next.slice(styleEnd);
  return next;
}
