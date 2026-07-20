import type { HelpCategory } from "./types";

// Ordered top-to-bottom in the Help Centre. Mirrors the app's own module
// grouping so the manual reads in the same shape as the product.
export const HELP_CATEGORIES: HelpCategory[] = [
  { key: "getting-started", label: "Getting started", description: "Sign in, find your way around, and set yourself up.", icon: "Compass" },
  { key: "crm", label: "CRM", description: "Leads, contacts, activities and the sales pipeline.", icon: "SquareKanban" },
  { key: "sales", label: "Sales & closing", description: "Quotes, deliveries, e-signatures, targets and forecasting.", icon: "FileText" },
  { key: "stock", label: "Stock & vehicles", description: "Inventory, purchase orders, reservations and the vehicle catalogue.", icon: "Package" },
  { key: "workshop", label: "Workshop", description: "Job cards, bookings, service schedules and warranty.", icon: "Wrench" },
  { key: "marketing", label: "Marketing", description: "Campaigns, surveys, referrals and lifecycle automation.", icon: "Megaphone" },
  { key: "comms", label: "Inbox & support", description: "The shared social inbox and the customer help desk.", icon: "MessageSquare" },
  { key: "automation", label: "Automation & AI", description: "Chatbot, flow builder and competitor intelligence.", icon: "Bot" },
  { key: "documents", label: "Documents", description: "Document library, templates and the document studio.", icon: "FolderOpen" },
  { key: "governance", label: "Reporting & records", description: "Reports, the audit log and the recycle bin.", icon: "ChartColumnIncreasing" },
  { key: "admin", label: "Administration", description: "Your account, company settings, users, roles, security and backups.", icon: "Cog" },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  HELP_CATEGORIES.map((c) => [c.key, c.label]),
);
