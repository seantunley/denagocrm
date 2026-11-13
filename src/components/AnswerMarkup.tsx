import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { parseAnswer, type Inline } from "@/lib/answerMarkup";
import type { Evidence } from "@/lib/assistantReply";

/**
 * A DAX answer with its formatting — bold, lists, small tables, links and evidence chips (lib/answerMarkup.ts).
 * React elements only, never HTML from the text.
 */
export default function AnswerMarkup({ text, evidence = [] }: { text: string; evidence?: Evidence[] }) {
  const inline = (parts: Inline[], key: string) =>
    parts.map((part, i) => {
      const k = `${key}-${i}`;
      if (part.t === "text") return <span key={k}>{part.v}</span>;
      if (part.t === "bold") return <strong key={k} className="font-semibold text-foreground">{part.v}</strong>;
      if (part.t === "link") {
        return part.external ? (
          <a key={k} href={part.href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{part.label}</a>
        ) : (
          <Link key={k} href={part.href} className="text-primary underline underline-offset-2">{part.label}</Link>
        );
      }
      // An evidence chip: the server numbered it, and only links its own lookups returned reach here.
      const source = evidence[part.n - 1];
      if (!source) return null;
      return (
        <Link
          key={k}
          href={source.href}
          title={`Open ${source.label}`}
          className="mx-0.5 inline-flex max-w-[12rem] items-center gap-0.5 truncate rounded-full border border-primary/30 bg-primary/5 px-1.5 align-baseline text-[11px] font-medium text-primary hover:bg-primary/10"
        >
          {source.label}
          <ArrowUpRight className="size-3 shrink-0" />
        </Link>
      );
    });

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {parseAnswer(text).map((block, b) => {
        if (block.type === "p") {
          return (
            <p key={b}>
              {block.lines.map((line, l) => (
                <span key={l}>
                  {l > 0 && <br />}
                  {inline(line, `${b}-${l}`)}
                </span>
              ))}
            </p>
          );
        }
        if (block.type !== "table") {
          const List = block.type;
          return (
            <List key={b} className={`space-y-1 pl-5 ${block.type === "ul" ? "list-disc" : "list-decimal"} marker:text-muted-foreground`}>
              {block.items.map((item, i) => <li key={i}>{inline(item, `${b}-${i}`)}</li>)}
            </List>
          );
        }
        return (
          <div key={b} className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>{block.head.map((cell, c) => <th key={c} scope="col" className="px-2.5 py-1.5 font-medium">{inline(cell, `${b}-h${c}`)}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {block.rows.map((row, r) => (
                  <tr key={r}>{row.map((cell, c) => <td key={c} className="px-2.5 py-1.5 align-top">{inline(cell, `${b}-${r}-${c}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
