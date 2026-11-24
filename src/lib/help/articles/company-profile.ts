import type { HelpArticle } from "../types";

/** Company profile, with the logo upload and the sign-in screen editor (2026-11-24). Replaces data/admin.json's copy. */
export const companyProfileArticles: HelpArticle[] = [
  {
    slug: "admin-company-profile",
    title: "Company profile: your details, logo and sign-in screen",
    summary: "Set your business details and logo, and customise the page your team signs in on.",
    category: "admin",
    audience: "admins",
    keywords: ["company", "business details", "logo", "address", "tagline", "branding", "sign-in screen", "login page", "background", "record names"],
    body: [
      { type: "p", text: "**Settings → Company profile** holds your business's details, your logo and your sign-in screen. Only owners can open it." },
      { type: "h", text: "Business details" },
      { type: "p", text: "Your **Business name**, **Tagline**, **Phone**, **Address**, **Email**, **Website**, **Facebook** and **Instagram** are printed on your documents and used in your emails. Leave a box empty if it doesn't apply, then press **Save business details**." },
      { type: "h", text: "Your logo" },
      { type: "steps", items: [
        "Under **Logo**, choose your logo file — PNG, JPEG, SVG or WebP, under 1 MB.",
        "Press **Upload logo**.",
      ] },
      { type: "p", text: "One logo is used everywhere: on the sign-in screen, in the app and on your documents. A logo with a transparent background looks best on the dark sign-in screen." },
      { type: "h", text: "Your sign-in screen" },
      { type: "p", text: "Under **Sign-in screen** you can change everything on the page your team signs in on. The preview beside the settings shows exactly what staff will see." },
      { type: "table", headers: ["Section", "What you can change"], rows: [
        ["Above the sign-in form", "The small label, the heading, the line under it ({name} becomes your business name), the sign-in button and the top-right label"],
        ["Right-hand side — background", "**Standard**, or **Your own photo** — a wide photo works best. The bottom is darkened so the headline stays readable."],
        ["Right-hand side — the card", "**Sample dashboard** (its title, three tile labels, sample numbers on or off, the chart caption and the pop-up note), **Your own picture**, or **Nothing**"],
        ["Headline at the bottom", "Two lines, and the line under them (blank uses your tagline)"],
      ] },
      { type: "steps", items: [
        "Make your changes and watch the preview.",
        "Press **Save sign-in screen**.",
      ] },
      { type: "callout", tone: "tip", text: "Leave a line blank to hide it. **Back to the standard screen** puts everything back as it was." },
      { type: "callout", tone: "info", text: "Pictures must be PNG, JPEG or WebP and under 4 MB. Your logo, name and colour are used automatically — the colour is set by your CRM provider." },
      { type: "h", text: "Names for records" },
      { type: "p", text: "**Names for records** lets you use your own word for a record — for example \"Enquiry\" instead of \"Lead\", or \"Work order\" instead of \"Job card\". Your words appear in the menu, page titles and buttons. Leave a box blank to keep the standard word." },
    ],
  },
];
