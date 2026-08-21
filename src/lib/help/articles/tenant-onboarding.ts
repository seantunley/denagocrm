import type { HelpArticle } from "../types";

export const tenantOnboardingArticles: HelpArticle[] = [
  {
    slug: "platform-new-tenant-onboarding",
    title: "Onboard a new tenant safely",
    summary: "Prepare a new workspace's identity, access and operating defaults before it goes live.",
    category: "admin",
    audience: "admins",
    keywords: ["tenant", "onboarding", "workspace", "logo", "branding", "domain", "modules", "activation", "security"],
    body: [
      { type: "p", text: "Creating a tenant now opens its dedicated onboarding page. The workspace remains **inert** while the platform setup is completed: its owner is disabled and cannot sign in until a platform administrator activates it." },
      { type: "h", text: "Platform setup before activation" },
      { type: "steps", items: [
        "Set the customer-facing **display name, tagline, accent colour and logo**. Logo uploads accept PNG, JPEG, SVG or WebP up to 1 MB.",
        "Grant only the optional **modules** included in the tenant's agreement. Core CRM is always present; tenant administrators may disable a granted pack but cannot grant themselves a new one.",
        "Attach and verify any custom **login domain**. An unverified hostname never resolves to the tenant, so it cannot display that tenant's brand.",
        "Confirm the provisioned owner is a tenant member. A user can belong to only one tenant.",
        "Activate only after tenant isolation enforcement is on and the readiness checks have been reviewed.",
      ] },
      { type: "h", text: "Tenant-owner handoff" },
      { type: "list", items: [
        "Complete the **Company profile**: legal and trading identity, address, contact details, social links, document identity and signature.",
        "Configure the **pipeline**: the default pipeline, stages, stale thresholds, required fields and ownership workflow.",
        "Set **quote and tax defaults**, document templates, validity, deposits, terms and numbering.",
        "Configure **email and notifications**, including SMTP/IMAP and sender identity.",
        "Connect tenant-owned **integrations and Social inbox** accounts. Never copy provider tokens or webhook secrets between workspaces.",
        "Invite the team, apply least-privilege roles, require 2FA, and test record visibility with a non-owner account.",
        "Import only this tenant's data, test a complete lead-to-quote flow, and verify the Inbox and Attention Centre before launch.",
      ] },
      { type: "callout", tone: "warning", text: "Readiness is calculated from the requested tenant's own branding, domain, module and membership records. Do not work around an incomplete check by reusing another tenant's settings, files, users, credentials or domains." },
    ],
  },
];
