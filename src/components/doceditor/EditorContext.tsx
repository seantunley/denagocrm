"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { EmailBrand } from "@/lib/doceditor/emailRender";
import type { DocumentModel } from "@/lib/doceditor/model";

/**
 * Server-resolved facts the canvas and panels need but the document model does
 * not carry: which template is open (so an uploaded image is filed under that
 * template's workspace) and the workspace's logo — the same embedded image the
 * printed document uses, so the banner on the canvas is the banner on paper.
 */
export type DocEditorEnv = {
  templateId: string | null;
  logoSrc: string;
  companyName: string;
  /**
   * Set when the document is a customer EMAIL (template key `email:…`): which
   * message (null = the shared frame), the fields it can use, sample values for
   * them, and the workspace's email brand — so the canvas draws the email blocks
   * as the email will, and "＋ field" offers only what that message can fill.
   */
  email?: {
    kind: string | null;
    fields: string[];
    sample: Record<string, string>;
    brand: EmailBrand;
    /**
     * For a MESSAGE: the workspace's email frame as it is being designed (its
     * header, signature, footer and colours), drawn around the message on the
     * canvas, and where to edit it. Absent on the frame itself.
     */
    frame?: { href: string | null; doc: DocumentModel };
  };
};

// No logo outside a provider: the banner then shows the company-name wordmark.
const DocEditorEnvContext = createContext<DocEditorEnv>({ templateId: null, logoSrc: "", companyName: "" });

export function DocEditorEnvProvider({ value, children }: { value: DocEditorEnv; children: ReactNode }) {
  return <DocEditorEnvContext.Provider value={value}>{children}</DocEditorEnvContext.Provider>;
}
export const useDocEditorEnv = () => useContext(DocEditorEnvContext);
