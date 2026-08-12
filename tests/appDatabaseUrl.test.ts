import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The app connects as `crm_app` in production, and as whatever `DATABASE_URL`
 * says everywhere else.
 *
 * RLS is only a boundary when the connecting role cannot step over it, and
 * `neondb_owner` carries BYPASSRLS — which is why 120 forced tables of policies
 * had never once been evaluated. `APP_DATABASE_URL` carries the non-bypassing
 * role.
 *
 * THE FALLBACK IS THE LOAD-BEARING PART. `DATABASE_URL` is owned by the
 * Neon–Vercel integration, which substitutes a DIFFERENT value per deployment so
 * each preview gets its own Neon branch. If the override were unconditional — or
 * lived in `schema.prisma`, where `env()` takes no fallback — previews and CI
 * would either fail to boot or, far worse, be pinned to the production string.
 * That is the 2026-07-24 incident: previews sharing the live database, which
 * `preview-database.yml` exists to prevent.
 */

const SOURCE = readFileSync(fileURLToPath(new URL("../src/lib/db.ts", import.meta.url)), "utf8").replace(
  /\r\n/g,
  "\n",
);
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the override is read from APP_DATABASE_URL and is optional", () => {
  assert.match(
    CODE,
    /const appDatabaseUrl = process\.env\.APP_DATABASE_URL\?\.trim\(\) \|\| undefined;/,
    "APP_DATABASE_URL must be optional; `|| undefined` also collapses an empty or whitespace-only value",
  );
});

test("it is spread in conditionally, never passed as undefined", () => {
  // `datasourceUrl: undefined` is NOT the same as omitting the key — it can
  // override the schema's own url with nothing. The spread is the only safe shape.
  assert.match(
    CODE,
    /\.\.\.\(appDatabaseUrl \? \{ datasourceUrl: appDatabaseUrl \} : \{\}\),/,
    "the key must be absent entirely when unset, so the schema's url stays in force",
  );
  assert.doesNotMatch(
    CODE,
    /datasourceUrl:\s*process\.env\.APP_DATABASE_URL/,
    "binding the env var straight to datasourceUrl loses the fallback previews and CI depend on",
  );
});

test("directUrl is untouched — migrations must stay on the owner", () => {
  const schema = readFileSync(
    fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  assert.match(
    schema,
    /url\s*=\s*env\("DATABASE_URL"\)/,
    "the schema url must remain DATABASE_URL — the override belongs at the client, where it can fall back",
  );
  assert.match(
    schema,
    /directUrl\s*=\s*env\("DATABASE_URL_UNPOOLED"\)/,
    "migrations run as the owner; crm_app has no DDL rights, so directUrl must not follow the app role",
  );
  assert.doesNotMatch(
    schema,
    /APP_DATABASE_URL/,
    "env() takes no fallback, so naming it here would force every environment to define it or fail to boot",
  );
});
