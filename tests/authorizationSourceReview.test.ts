import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Consolidating route access onto RBAC (see oneAuthorizationSource.test.ts) made
 * the permission the ONLY thing standing between a user and a screen. Review of
 * that change found three places where the permission was doing less work than it
 * looked like it was doing, plus one invariant worth nailing down:
 *
 *   1. /health is gated on contacts.view_all OR contacts.view_owned, but
 *      bulkHealth() read every contact in the tenant with no ownership filter.
 *   2. CUSTOMER_RECORD_PERMISSIONS was four VIEW keys, and it gated logging a
 *      communication, deleting one, pinning one and SENDING EMAIL — a read
 *      permission that could write and send.
 *   3. findPossibleDuplicates() answered from a tenant-wide contact search, so a
 *      scoped user could read back names, emails and phone numbers of contacts
 *      /contacts refuses them.
 *   4. Every RBAC-affecting write must bump User.sessionVersion, because the edge
 *      proxy decides from the `rg` claim minted at sign-in.
 *
 * These are source-scanning tests: the code they guard is server-only and reaches
 * the database, so the cheapest honest assertion is that the scope is still
 * written down where it has to be.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Body of a top-level exported function. The end is searched FROM the start
 * index — an unbounded indexOf finds an earlier `export` and slices backwards to
 * an empty string, which passes every assertion below.
 */
function fnBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const end = source.indexOf("\nexport ", start + 1);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const sourceFiles = walk(path.join(root, "src")).filter((f) => /\.tsx?$/.test(f));
const rel = (abs: string) => abs.slice(root.length + 1).replace(/\\/g, "/");

/** The string literals inside `export const NAME = [ … ]`. */
function keysIn(source: string, name: string): string[] {
  const start = source.indexOf(`export const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const end = source.indexOf("]", start);
  assert.notEqual(end, -1, `${name} has no closing bracket`);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/* ── 1. the health dashboard is scoped to the caller ──────────────────── */

test("customer health scores only the contacts the caller may see", () => {
  // `take: 3000` with no WHERE meant a contacts.view_owned rep opened /health and
  // read tenant-wide customer names, companies and health signals — every record
  // /contacts would have hidden from them.
  const body = fnBody(shipped("src/lib/healthData.ts"), "bulkHealth");
  assert.match(
    body,
    /export async function bulkHealth\(user: PermissionUser\)/,
    "the scope must be a required argument, not an optional refinement a caller can omit",
  );
  assert.match(body, /getAccessibleContactIds\(user\)/, "the scope must come from the shared helper");
  assert.match(
    body,
    /if \(contactIds !== null && contactIds\.length === 0\) return \[\];/,
    "a scoped user with nothing accessible must score nothing, not fall through to an unfiltered read",
  );
  assert.match(
    body,
    /where: contactIds === null \? \{\} : \{ id: \{ in: contactIds \} \}/,
    "the contact read must be filtered by the accessible ids",
  );

  const scope = body.indexOf("getAccessibleContactIds(user)");
  const load = body.indexOf("prisma.contact.findMany");
  assert.notEqual(load, -1, "it must still read contacts — has it been gutted?");
  assert.ok(scope < load, `the scope must be resolved before the read (scope ${scope}, read ${load})`);
});

test("the survey scores behind the dashboard carry the same scope", () => {
  // Sentiment is customer data too: an unscoped surveyScoreMap() pulled every
  // contact's NPS/CSAT into memory on its way to being discarded.
  const code = shipped("src/lib/healthData.ts");
  assert.match(
    code,
    /async function surveyScoreMap\(contactIds: string\[\] \| null\)/,
    "surveyScoreMap must be told which contacts it may read",
  );
  assert.match(
    code,
    /contactId: contactIds === null \? \{ not: null \} : \{ in: contactIds \}/,
    "…and must apply it",
  );
});

test("every bulkHealth caller hands it the caller's identity", () => {
  const callers = sourceFiles.filter((f) => /\bbulkHealth\s*\(/.test(shipped(rel(f))));
  assert.deepEqual(
    callers.map(rel).sort(),
    ["src/app/(app)/health/page.tsx", "src/lib/healthData.ts"],
    "a new consumer must be reviewed for the same scoping bug",
  );
  for (const file of callers) {
    assert.doesNotMatch(
      shipped(rel(file)),
      /bulkHealth\(\s*\)/,
      `${rel(file)} calls bulkHealth with no scope`,
    );
  }

  const page = shipped("src/app/(app)/health/page.tsx");
  assert.match(page, /const user = await requireRoute\("\/health"\)/, "the route gate must yield the caller");
  assert.match(page, /bulkHealth\(user\)/, "…and that caller must scope the dashboard");
});

/* ── 2. a view permission cannot write or send ────────────────────────── */

test("the customer-record read list is view permissions and nothing else", () => {
  const perms = shipped("src/lib/permissions.ts");
  const keys = keysIn(perms, "CUSTOMER_RECORD_READ_PERMISSIONS");
  assert.ok(keys.length > 0, "the read list must not be empty");
  for (const key of keys) {
    assert.match(
      key,
      /\.view(_all|_owned)?$/,
      `${key} is not a view permission — the read list must stay read-grade`,
    );
  }
});

test("the customer-record write list is write permissions from the real catalogue", () => {
  const perms = shipped("src/lib/permissions.ts");
  const catalogue = new Set(keysIn(perms, "PERMISSIONS"));
  const keys = keysIn(perms, "CUSTOMER_RECORD_WRITE_PERMISSIONS");
  assert.ok(keys.length > 0, "the write list must not be empty");
  for (const key of keys) {
    assert.ok(catalogue.has(key), `${key} is not in PERMISSIONS — a gate on an invented key grants nobody anything`);
    assert.doesNotMatch(key, /\.view(_all|_owned)?$/, `${key} is a view permission and cannot authorise a write`);
  }
});

test("the ambiguous single list is gone, so nothing can pick the wrong grade", () => {
  // The escalation was possible because ONE list named "customer record
  // permissions" read as "may work with customer records" at every call site,
  // whether that site read or wrote. The name had to split with the meaning.
  const offenders = sourceFiles.filter((f) => /\bCUSTOMER_RECORD_PERMISSIONS\b/.test(read(rel(f))));
  assert.deepEqual(offenders.map(rel), [], "use the READ or the WRITE list explicitly");
});

test("logging, deleting, pinning and sending all need a write-grade permission", () => {
  // Each of these was gated on the four VIEW keys, so contacts.view_owned alone
  // was enough to write to another team's timeline — and to send mail from the
  // workspace's own address with the caller's signature on it.
  const writers: Array<[string, string]> = [
    ["src/app/actions/communications.ts", "addCommunication"],
    ["src/app/actions/communications.ts", "toggleCommunicationPin"],
    ["src/app/actions/communications.ts", "deleteCommunication"],
    ["src/app/actions/emails.ts", "sendEmailAction"],
  ];
  for (const [file, name] of writers) {
    const body = fnBody(shipped(file), name);
    assert.match(
      body,
      /requireAnyPermission\(\.\.\.CUSTOMER_RECORD_WRITE_PERMISSIONS\)/,
      `${name} writes or sends, so it must demand the write list`,
    );
    assert.doesNotMatch(
      body,
      /CUSTOMER_RECORD_READ_PERMISSIONS/,
      `${name} must not be reachable on a view permission`,
    );
  }
});

/* ── 3. the duplicate checker is scoped too ───────────────────────────── */

test("the duplicate checker searches only contacts the caller may see", () => {
  // Same leak the `mode: "insensitive"` fix inside this function already fought,
  // reached through the WHERE clause instead of the operator: type a name
  // fragment and read back the id, name, email and phone of contacts /contacts
  // refuses you.
  const body = fnBody(shipped("src/app/actions/ai.ts"), "findPossibleDuplicates");
  assert.match(
    body,
    /const user = await requireAnyPermission\(\.\.\.CUSTOMER_RECORD_READ_PERMISSIONS\)/,
    "the gate must yield the caller — this is a read, but a scoped one",
  );
  assert.match(body, /getAccessibleContactIds\(user\)/, "the scope must come from the shared helper");
  assert.match(
    body,
    /if \(contactIds !== null && contactIds\.length === 0\) return \[\];/,
    "a scoped user with nothing accessible must match nothing",
  );
  assert.match(
    body,
    /\.\.\.\(contactIds === null \? \{\} : \{ id: \{ in: contactIds \} \}\)/,
    "the search must be confined to the accessible ids",
  );

  const scope = body.indexOf("getAccessibleContactIds(user)");
  const load = body.indexOf("prisma.contact.findMany");
  assert.notEqual(load, -1, "it must still search contacts — has it been gutted?");
  assert.ok(scope < load, `the scope must be resolved before the search (scope ${scope}, search ${load})`);
});

/* ── 4. a role change revokes the sessions carrying the old role ──────── */

test("promoting or demoting a user revokes the sessions carrying the old role", () => {
  // The edge proxy decides from the `rg` grant claim and the `role` claim minted
  // at sign-in; only getCurrentUser re-reads the role from the database. Without
  // this bump a demoted owner would keep the edge short-circuit
  // (`claims.role === "owner"` opens every gated prefix) until their token aged
  // out, even though requireOwner() on the page itself would already refuse them.
  // Every other RBAC-affecting write — updateRolePermissions, updateUserRoles —
  // bumps; this one must not be the exception.
  const body = fnBody(shipped("src/app/actions/security.ts"), "setUserRole");

  const txStart = body.indexOf("basePrisma.$transaction(");
  assert.notEqual(txStart, -1, "the role write must still be transactional");
  const txEnd = body.indexOf("}, GOVERNANCE_TX);", txStart);
  assert.notEqual(txEnd, -1, "the governance transaction must still close");
  const tx = body.slice(txStart, txEnd);

  const write = tx.indexOf("data: { role }");
  const bump = tx.indexOf("bumpUserSessionVersion(userId, tx)");
  assert.notEqual(write, -1, "setUserRole must still write the role");
  assert.notEqual(
    bump,
    -1,
    "setUserRole must revoke the target's sessions — a stale token keeps the old role at the edge",
  );
  assert.ok(bump > write, `the revocation must follow the role write (write ${write}, bump ${bump})`);
});
