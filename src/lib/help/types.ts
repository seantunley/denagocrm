// Content model for the in-app Help Centre and the printable user manual. Pure
// data (no React imports) so the same articles render in the app, in search,
// and in the print/manual view. Authored by hand for Getting Started and
// assembled per module from the codebase for the rest.

export type HelpBlock =
  | { type: "p"; text: string } // paragraph; inline **bold** is honoured
  | { type: "h"; text: string } // subheading within an article
  | { type: "steps"; items: string[] } // ordered how-to
  | { type: "list"; items: string[] } // unordered bullets
  | { type: "callout"; tone: "tip" | "warning" | "info"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export type HelpAudience = "everyone" | "managers" | "admins";

export type HelpCategoryKey =
  | "getting-started"
  | "crm"
  | "sales"
  | "stock"
  | "workshop"
  | "marketing"
  | "comms"
  | "automation"
  | "documents"
  | "governance"
  | "admin";

export type HelpArticle = {
  slug: string;
  title: string;
  summary: string;
  category: HelpCategoryKey;
  audience: HelpAudience;
  keywords: string[];
  body: HelpBlock[];
};

export type HelpCategory = {
  key: HelpCategoryKey;
  label: string;
  description: string;
  icon: string; // lucide-react icon name, resolved in the UI layer
};
