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
    // Prisma's `mode: "insensitive"` compiles to ILIKE, and the value is bound
    // UNESCAPED — so `_` and `%` in it are wildcards. With `contains` that is
    // what you asked for. With `equals`/`startsWith`/`endsWith` it is not: the
    // query reads as an equality and behaves as a pattern match, which is how a
    // portal login came to resolve `john_smith@…` to a different customer's
    // account. Use ciExactIds/ciExactIdFilter from @/lib/ciExact instead.
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Both `:has()` legs use the CHILD combinator so the two properties must
          // sit in the same filter object. A descendant match would flag
          // `{ firstName: { contains: q, mode: "insensitive" }, id: { equals: x } }`,
          // which is fine. The inner `:has(Literal…)` rather than `> Literal…` is
          // what lets this see through `mode: "insensitive" as const`, the form
          // used in the .tsx call sites.
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
