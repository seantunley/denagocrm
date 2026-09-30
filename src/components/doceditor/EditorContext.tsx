"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Server-resolved facts the canvas and panels need but the document model does
 * not carry: which template is open (so an uploaded image is filed under that
 * template's workspace) and the workspace's logo — the same embedded image the
 * printed document uses, so the banner on the canvas is the banner on paper.
 */
export type DocEditorEnv = { templateId: string | null; logoSrc: string; companyName: string };

// No logo outside a provider: the banner then shows the company-name wordmark.
const DocEditorEnvContext = createContext<DocEditorEnv>({ templateId: null, logoSrc: "", companyName: "" });

export function DocEditorEnvProvider({ value, children }: { value: DocEditorEnv; children: ReactNode }) {
  return <DocEditorEnvContext.Provider value={value}>{children}</DocEditorEnvContext.Provider>;
}
export const useDocEditorEnv = () => useContext(DocEditorEnvContext);
