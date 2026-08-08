import type { MarkdownCard } from "@/lib/dashboard/config";
import { CardShell, type RenderContext, type RenderedCard } from "./shell";

/**
 * A note to the team, pinned to the dashboard.
 *
 * ── WHAT THIS IS NOT DOING, AND WHY ─────────────────────────────────────────
 *
 * The card type is called `markdown` and the schema's comment promises "the same
 * sanitising renderer the rest of the app uses". There is no such renderer. The
 * app has no markdown dependency at all — no react-markdown, no marked, no
 * remark, no sanitiser — and the closest thing to one is a private helper inside
 * components/help/ArticleBody.tsx that understands `**bold**` and nothing else,
 * over a typed block array rather than over text.
 *
 * So this renders PLAIN TEXT with its line breaks kept, and that is a deliberate
 * stop rather than a stub. The two alternatives were both worse:
 *
 *   Hand-rolling a markdown parser here would put a new HTML-producing path on
 *   the home screen, authored by whoever can save a dashboard and read by
 *   everyone they share it with. Every markdown parser worth having produces
 *   links and raw HTML, and this codebase has already paid for one stored XSS on
 *   a public page (see the header of lib/doceditor/css.ts). A note card is not
 *   worth reopening that surface.
 *
 *   Adding a dependency and a sanitiser is a real change with a real review, not
 *   something to smuggle in under a card renderer.
 *
 * Every character below reaches the page as a JSX text node. React escapes it,
 * there is no `dangerouslySetInnerHTML` anywhere in this module, and so a note
 * containing `<script>` is a note containing the word "script".
 *
 * When a sanitising renderer does arrive, this is the one function that changes.
 */
export function renderMarkdown(card: MarkdownCard, _ctx: RenderContext): RenderedCard {
  // Blank lines separate paragraphs; single newlines are breaks within one. That
  // is the one piece of markdown's shape worth honouring without a parser,
  // because it is the shape people type without thinking about it.
  const paragraphs = card.content
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "");

  if (paragraphs.length === 0) return { node: null, signals: {} };

  return {
    node: (
      <CardShell title={card.title}>
        <div className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
          {paragraphs.map((block, blockIndex) => (
            // Index keys, and legitimately so: these are positional fragments of
            // one string with no identity of their own, and nothing about them
            // reorders between renders.
            <p key={`p-${blockIndex}`} className="break-words">
              {block.split("\n").map((line, lineIndex) => (
                <span key={`l-${lineIndex}`}>
                  {lineIndex > 0 && <br />}
                  {line}
                </span>
              ))}
            </p>
          ))}
        </div>
      </CardShell>
    ),
    signals: {},
  };
}
