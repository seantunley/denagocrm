import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // The Next preset ships the React Compiler advisory rules at error level.
    // They flag long-standing patterns across the app (components declared in
    // render, setState-in-effect, Date.now in render) that build and run fine.
    // Surface them as warnings pending a dedicated React Compiler migration
    // rather than blocking CI on a risky repo-wide refactor.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
    },
  },
  {
    // ONE no-restricted-syntax block, holding every banned pattern.
    //
    // This must stay one block. Flat config MERGES config objects by key, so a
    // second object setting `rules: { "no-restricted-syntax": [...] }` REPLACES
    // this array for any file both objects match — it does not add to it. Two
    // separate blocks would therefore silently disable one of these rules while
    // both still appeared present in the file. That nearly happened: the two
    // rules below arrived in different PRs, each adding its own block.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Secrets must be compared in constant time. `a === b` on a string
          // short-circuits at the first differing byte, so how long it takes to
          // fail leaks how much of the prefix was right. Every secret check here
          // used crypto.timingSafeEqual except the Telegram webhook and the
          // Meta/WhatsApp verify-token handshake — this stops the next one
          // drifting back.
          //
          // The name list is deliberately narrow. `signature` and a bare `token`
          // are all over this codebase in non-secret comparisons
          // (signatureRef === null, status checks), and a rule that cries wolf
          // is a rule someone disables.
          selector:
            "BinaryExpression[operator=/^([!=]==?)$/] > :matches(Identifier, MemberExpression > Identifier.property)[name=/(secret|password|passphrase|hmac|apikey|api_key|verifytoken|webhooksecret)/i]",
          message:
            "Compare secrets in constant time with secretEquals() from @/lib/secretCompare — `===` leaks how much of the prefix matched.",
        },
        {
          // Prisma's `mode: "insensitive"` compiles to ILIKE, and the value is
          // bound UNESCAPED — so `_` and `%` in it are wildcards. With
          // `contains` that is what you asked for. With
          // `equals`/`startsWith`/`endsWith` it is not: the query reads as an
          // equality and behaves as a pattern match, which is how a portal login
          // came to resolve `john_smith@…` to a different customer's account.
          // Use ciExactIds/ciExactIdFilter from @/lib/ciExact instead.
          //
          // Both `:has()` legs use the CHILD combinator so the two properties
          // must sit in the same filter object. A descendant match would flag
          // `{ firstName: { contains: q, mode: "insensitive" }, id: { equals: x } }`,
          // which is fine. The inner `:has(Literal…)` rather than `> Literal…`
          // is what lets this see through `mode: "insensitive" as const`, the
          // form used in the .tsx call sites.
          selector:
            'ObjectExpression:has(> Property[key.name="mode"]:has(Literal[value="insensitive"])):has(> Property[key.name=/^(equals|startsWith|endsWith)$/])',
          message:
            'mode: "insensitive" is an unescaped ILIKE — `_` and `%` in the value are wildcards. Use ciExactIds()/ciExactIdFilter() from @/lib/ciExact for an exact case-folded match. (`contains` + insensitive is fine and not flagged.)',
        },
      ],
    },
  },
]);

export default eslintConfig;
