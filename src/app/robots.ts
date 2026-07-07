import type { MetadataRoute } from "next";

/**
 * This is a private business app — no crawler, AI or otherwise, should index
 * or scrape it. Combined with the global X-Robots-Tag: noindex header and the
 * WAF crawler-deny rules, this keeps the CRM out of search engines and AI
 * training/scraping pipelines that honour robots.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
