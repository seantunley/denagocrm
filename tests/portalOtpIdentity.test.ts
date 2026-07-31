import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Portal login resolved the account with Prisma's `equals` + `mode:
 * "insensitive"`, which compiles to ILIKE with the value bound UNESCAPED — so
 * `_` and `%` in the submitted address were LIKE wildcards.
 *
 * That was an account takeover, not a curiosity: the code is emailed to the
 * SUBMITTED address while the session is minted for the MATCHED contact.
 * Register `john_smith@outlook.com`, request a portal code, receive it in your
 * own inbox, enter it, and you are signed in as `john.smith@outlook.com`.
 * No prior access required.
 *
 * Reproduced against a real database before fixing; all three wildcard shapes
 * (`_`, `%`, trailing `_`) resolved to a different real contact.
 */

test("portal login does not resolve an account with a LIKE", () => {
  const code = src("src/app/actions/portal.ts");
  assert.doesNotMatch(
    code.replace(/\/\*[\s\S]*?\*\//g, ""), // the explanatory comment quotes the old form
    /mode:\s*"insensitive"/,
    "an ILIKE lookup on the login path is an account-takeover primitive",
  );
  assert.match(code, /LOWER\("email"\) = \$\{email\}/, "identity must be matched exactly");
});

test("the login lookup stays case-insensitive — a real customer depends on it", () => {
  // Production has a contact whose stored address is mixed-case. A plain `=`
  // would close the hole and lock them out, which is not a fix.
  const code = src("src/app/actions/portal.ts");
  assert.match(code, /LOWER\("email"\)/, "must fold case rather than compare raw");
});

test("the login lookup is deterministic", () => {
  // findFirst with no ORDER BY left it unspecified which of two matching rows
  // you got — so the request and verify legs of one login could disagree.
  const code = src("src/app/actions/portal.ts");
  const fn = code.slice(code.indexOf("async function findPortalContactByEmail"));
  assert.match(fn.slice(0, 600), /ORDER BY/, "the resolution must not depend on row order");
});

test("both legs of the login use the same resolver", () => {
  // requestPortalOtp mails the code; verifyPortalOtp mints the session. If they
  // resolve the contact differently, the session is for a different account
  // than the one the code was sent to — which is the whole bug.
  const code = src("src/app/actions/portal.ts");
  const uses = (code.match(/await findPortalContactByEmail\(email\)/g) ?? []).length;
  assert.equal(uses, 2, "request and verify must both go through the exact resolver");
});

test("the portal never hands out another signer's token", () => {
  // Same root cause, different consequence: an ILIKE on the recipient email
  // would give a viewer whose own address contains `_` the signing token
  // belonging to a different signer on the same quote.
  const page = src("src/app/portal/page.tsx");
  const recipientsBlock = page.slice(page.indexOf("recipients: {"), page.indexOf("signTokenByQuote"));
  assert.doesNotMatch(recipientsBlock, /mode:\s*"insensitive"/, "no LIKE match on a signing recipient");
  assert.match(page, /r\.email\?\.toLowerCase\(\) === viewerEmail/, "the signer must be matched exactly");
});
