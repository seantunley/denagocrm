/**
 * The paper an HTML document asks to be printed on.
 *
 * A document set to Letter says so in its own page rule — `@page { size: letter; … }`
 * — and was laid out 816px wide to fit it. But the PDF step printed everything
 * on A4, whatever the document said: the engine takes the paper from the
 * `format` it is given and does not read the sheet size out of the CSS. So a
 * Letter document came out on A4, 22px too wide for its paper.
 *
 * Read from the document's own stylesheet only (everything before the first
 * `</style>`), never its body: words a person typed into the document must not
 * be able to change the paper.
 */
export function pdfPaperFor(html: string): "A4" | "Letter" {
  const end = html.indexOf("</style>");
  const styles = end === -1 ? "" : html.slice(0, end);
  return /@page\s*\{\s*size:\s*letter\b/i.test(styles) ? "Letter" : "A4";
}
