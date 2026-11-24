import { SaveButton, SaveForm } from "@/components/SaveForm";
import { saveHelpGuide } from "@/app/actions/helpGuides";
import { HELP_CATEGORIES } from "@/lib/help/categories";
import { MAX_BODY, MAX_SUMMARY, MAX_TITLE, type CustomGuide } from "@/lib/help/customGuides";

/** Write or edit one of the workspace's own guides (lib/help/customGuides.ts). Plain text with five marks; no editor to learn. */
export default function GuideForm({ guide }: { guide?: CustomGuide }) {
  return (
    <SaveForm action={saveHelpGuide} success={guide ? "Guide saved" : "Guide added"} resetOnSuccess={!guide} className="card space-y-4">
      {guide && <input type="hidden" name="id" value={guide.id} />}
      <div>
        <label className="label" htmlFor="guide-title">Title</label>
        <input id="guide-title" name="title" className="input" required maxLength={MAX_TITLE} defaultValue={guide?.title} placeholder="e.g. How we handle trade-ins" />
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div>
          <label className="label" htmlFor="guide-summary">One-line summary (optional)</label>
          <input id="guide-summary" name="summary" className="input" maxLength={MAX_SUMMARY} defaultValue={guide?.summary} placeholder="What someone will know after reading it" />
        </div>
        <div>
          <label className="label" htmlFor="guide-area">Area</label>
          <select id="guide-area" name="area" className="input" defaultValue={guide?.area ?? "getting-started"}>
            {HELP_CATEGORIES.map((category) => (
              <option key={category.key} value={category.key}>{category.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="guide-body">The guide</label>
        <textarea
          id="guide-body"
          name="body"
          className="input min-h-72 font-mono text-[13px] leading-6"
          required
          maxLength={MAX_BODY}
          defaultValue={guide?.body}
          aria-describedby="guide-body-help"
          placeholder={"# Before the customer arrives\n\n1. Check the trade-in's service history\n2. Photograph it front, back and both sides\n\n> Never agree a value by phone."}
        />
        <p id="guide-body-help" className="mt-1.5 text-xs leading-5 text-muted-foreground">
          Plain text. Start a line with <code># </code> for a heading, <code>- </code> for a bullet, <code>1. </code> for a numbered step and <code>&gt; </code> for a tip in a box. Put <code>**two stars**</code> around words to make them bold. Leave a blank line between paragraphs.
        </p>
      </div>
      <SaveButton className="btn-primary">{guide ? "Save changes" : "Add guide"}</SaveButton>
    </SaveForm>
  );
}
