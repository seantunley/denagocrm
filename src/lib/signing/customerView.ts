/**
 * When the CUSTOMER first opened a signing request — not whoever opened it
 * first. A staff countersigner, an approver or a colleague reviewing the
 * document also leaves a viewedAt on their recipient row, and "Lisa opened her
 * quote" must not come from Sean opening it to countersign (#781 review).
 *
 * `isCustomer` decides who the customer is (quoteMirror.isCustomerSigner: a
 * signer who isn't staff of the request's own workspace). Pure, so it can be
 * tested without a database.
 */
export type ViewingRecipient = { role: string; email: string | null; viewedAt: Date | null };

export async function firstCustomerView(
  recipients: ViewingRecipient[],
  isCustomer: (r: ViewingRecipient) => Promise<boolean>,
): Promise<Date | null> {
  let first: Date | null = null;
  // Earliest first, so the staff check runs only until the first customer open.
  for (const r of [...recipients].filter((x) => x.viewedAt).sort((a, b) => a.viewedAt!.getTime() - b.viewedAt!.getTime())) {
    if (await isCustomer(r)) {
      first = r.viewedAt;
      break;
    }
  }
  return first;
}

/**
 * One staff check per address per lookup — a quote list asks about the same
 * few people many times. Keyed by role and case-folded email.
 */
export function memoCustomer(check: (r: ViewingRecipient) => Promise<boolean>): (r: ViewingRecipient) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (r) => {
    const key = `${r.role}|${(r.email ?? "").trim().toLowerCase()}`;
    let hit = seen.get(key);
    if (!hit) {
      hit = check(r);
      seen.set(key, hit);
    }
    return hit;
  };
}
