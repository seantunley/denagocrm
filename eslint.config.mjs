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
    // Secrets must be compared in constant time. `a === b` on a string
    // short-circuits at the first differing byte, so how long it takes to fail
    // leaks how much of the prefix was right. Every secret check here used
    // crypto.timingSafeEqual except the Telegram webhook and the Meta/WhatsApp
    // verify-token handshake — this stops the next one drifting back.
    //
    // The name list is deliberately narrow. `signature` and a bare `token` are
    // all over this codebase in non-secret comparisons (signatureRef === null,
    // status checks), and a rule that cries wolf is a rule someone disables.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "BinaryExpression[operator=/^([!=]==?)$/] > :matches(Identifier, MemberExpression > Identifier.property)[name=/(secret|password|passphrase|hmac|apikey|api_key|verifytoken|webhooksecret)/i]",
          message:
            "Compare secrets in constant time with secretEquals() from @/lib/secretCompare — `===` leaks how much of the prefix matched.",
        },
      ],
    },
  },
]);

export default eslintConfig;
