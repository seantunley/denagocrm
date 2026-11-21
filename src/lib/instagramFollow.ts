import "server-only";
import { metaPageToken } from "./messenger";
import { logError } from "./errorLog";

/**
 * DOES THIS INSTAGRAM PERSON FOLLOW US? (Instagram follow gate, Sean 2026-11-21: comment → follows us → the guide.)
 *
 * Instagram's User Profile API: GET /{IGSID}?fields=is_user_follow_business with the Page token, this workspace's own
 * (its own Meta app). Meta answers only for someone who has messaged the account — a comment alone grants no consent —
 * which is why the flow asks them to reply first. Anything Meta can't answer (no consent yet, a token problem, a
 * timeout) is "no": the flow then asks them to follow and check again, never sends the guide unchecked.
 *
 * The token goes in the Authorization header, never the URL, so it can't be logged with one.
 */
const GRAPH = "https://graph.facebook.com/v21.0";

export async function instagramFollowsUs(igsid: string): Promise<boolean> {
  if (!/^\d{5,32}$/.test(igsid)) return false;
  const token = await metaPageToken();
  if (!token) return false;
  try {
    const res = await fetch(`${GRAPH}/${igsid}?fields=is_user_follow_business`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // Meta's code only — never the person's id or the token.
      const code = (await res.json().catch(() => null))?.error?.code;
      await logError("instagram-follow-check", `Instagram couldn't say whether a person follows the account (HTTP ${res.status}${code ? `, code ${code}` : ""}); treated as not following.`, undefined, { alert: false }).catch(() => {});
      return false;
    }
    return (await res.json().catch(() => null))?.is_user_follow_business === true;
  } catch (error) {
    await logError("instagram-follow-check", error instanceof Error ? error.name : "unknown", "Follow check failed; treated as not following.", { alert: false }).catch(() => {});
    return false;
  }
}
