/**
 * What "Paste" in the editor's right-click menu takes from one clipboard item —
 * the same choice Ctrl+V makes (RichTextEditor's handlePaste): a picture on its
 * own (a screenshot) goes in as a picture; anything with text in it is left to
 * the editor, formatted when the clipboard has HTML, plain otherwise.
 */
export function pasteKind(types: readonly string[]): "image" | "html" | "text" | null {
  if (!types.includes("text/plain") && types.some((type) => type.startsWith("image/"))) return "image";
  if (types.includes("text/html")) return "html";
  if (types.includes("text/plain")) return "text";
  return null;
}
