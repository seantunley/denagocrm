/**
 * AMBIENT DECLARATION FOR `embedded-postgres`, WHICH IS NOT A DEPENDENCY.
 *
 * The package downloads ~130MB of real PostgreSQL server binaries. Every
 * `npm ci` would pay for that, including CI's — and CI does not need it: the
 * `integration` job already runs a postgres:16-alpine service and sets
 * TENANT_HARNESS_DATABASE_URL. So it is installed on demand for local runs
 * (`npm run harness:install-postgres`) and reached by dynamic import, whose
 * failure is a clear instruction rather than a stack trace. See the header of
 * ../testDatabase.ts.
 *
 * But `tsconfig.json` includes `**\/*.ts`, so `tsc --noEmit` compiles
 * scripts/harness/ and fails with TS2307 on a module that is deliberately
 * absent. This file is the fix. It is a SHIM, not a suppression: `@ts-ignore`
 * or `as any` on the import would also silence TS2307 and would additionally
 * stop type-checking every option name and method call at the call site — the
 * exact place a typo (`databaseDirectory`, `initialize`) turns into a runtime
 * failure on a developer machine that CI can never see.
 *
 * SCOPE: only the surface scripts/harness/testDatabase.ts actually uses.
 * Reaching for anything else (getPgClient, dropDatabase, authMethod,
 * initdbFlags, postgresFlags, createPostgresUser) is a type error, which is the
 * intended prompt to come back here and widen it against the real package
 * rather than guess.
 *
 * TRANSCRIBED FROM embedded-postgres@18.4.0-beta.17 — dist/index.d.ts and
 * dist/types.d.ts. To re-check after an upgrade:
 *   npm run harness:install-postgres
 *   cat node_modules/embedded-postgres/dist/types.d.ts
 * An ambient declaration takes precedence over the resolved package even when
 * that package IS installed, so a machine with it installed will NOT surface
 * drift between this file and the real one. Only reading the real .d.ts will.
 */

declare module "embedded-postgres" {
  /**
   * Constructor options. The real interface has more fields; these are the ones
   * this repository passes. All optional, as upstream takes `Partial<…>`.
   */
  interface EmbeddedPostgresOptions {
    /** Where the cluster's data is persisted. Upstream default: `./data/db`. */
    databaseDir: string;
    /** Port the server listens on. Upstream default: `5432`. */
    port: number;
    /** Superuser to create and connect as. Upstream default: `postgres`. */
    user: string;
    /** That user's password. Upstream default: `password`. */
    password: string;
    /**
     * Leave the data directory in place on stop(). Upstream default: `true`.
     * The harness sets it explicitly because `false` DELETES the data
     * directory, which is what makes a rerun a ~6 minute re-migration.
     */
    persistent: boolean;
    /** Relay for postgres/initdb stdout. Upstream default: `console.log`. */
    onLog: (message: string) => void;
    /** Relay for postgres/initdb stderr. Upstream default: `console.error`. */
    onError: (messageOrError: string | Error | unknown) => void;
  }

  /**
   * One managed PostgreSQL cluster. The server runs as a separate process that
   * does NOT die with the Node process that started it — the reason
   * testDatabase.ts has an adopt-an-already-listening-server path.
   */
  class EmbeddedPostgres {
    constructor(options?: Partial<EmbeddedPostgresOptions>);
    /** Populate an empty data directory. Throws if it is not empty. */
    initialise(): Promise<void>;
    /** Start the cluster. Throws if the data directory is uninitialised. */
    start(): Promise<void>;
    /** Stop the cluster. */
    stop(): Promise<void>;
    /** CREATE DATABASE on the running cluster. */
    createDatabase(name: string): Promise<void>;
  }

  export default EmbeddedPostgres;
  export type { EmbeddedPostgresOptions };
}
