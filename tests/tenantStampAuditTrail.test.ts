import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * THE AUDIT TRAIL AND ITS NEIGHBOURS MUST KNOW WHOSE THEY ARE.
 *
 * Production, read-only, 2026-08-10: 843 rows written in a fortnight with
 * `tenantId` NULL, by code paths still running. A NULL-tenant row is invisible to
 * the workspace that created it the moment enforcement is switched on — so for the
 * audit tables that means an audit trail the workspace cannot read back, which is
 * the one thing an audit trail exists not to be.
 *
 * The mechanism, in three flavours:
 *   1. `writeTenantId()` returns null while enforcement is dormant, so anything
 *      that stamps from it stamps nothing;
 *   2. a write through `basePrisma`, or through raw SQL, where the db.ts guard
 *      never runs at all — TimelinePin was 7 of 7 unowned for exactly this reason;
 *   3. the tenant is known and thrown away — the bookings API resolves it from the
 *      API key and then discards it.
 *
 * These tests are deliberately of three kinds, because the bug has three shapes:
 * pure rules, the real modules driven against a fake database, and source
 * assertions for the writes that no harness can reach (a raw INSERT's column list).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** Source with comments removed — a rule satisfied by a comment is not satisfied. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const require_ = createRequire(import.meta.url);

/** Every .ts/.tsx file under a directory, repo-relative. */
const walk = (dir: string): string[] => {
  const { readdirSync, statSync } = require_("node:fs") as typeof import("node:fs");
  return readdirSync(path.join(root, dir)).flatMap((entry) => {
    const rel = `${dir}/${entry}`;
    return statSync(path.join(root, rel)).isDirectory()
      ? walk(rel)
      : /\.tsx?$/.test(entry)
        ? [rel]
        : [];
  });
};

/* ────────────────────────────────────────────────────────────────────────────
 * 1. The pure rules
 * ──────────────────────────────────────────────────────────────────────────── */

const rules = require_("../src/lib/compositeTenantRules.ts") as typeof import("../src/lib/compositeTenantRules");

/**
 * The rule, one row per case. `agreed` is what the OPERATIONAL rule must answer;
 * `"refuse"` means it must throw rather than return anything at all.
 */
const RULE_TABLE: ReadonlyArray<{
  what: string;
  referenced: Array<string | null>;
  fallback: string | null;
  agreed: string | null | "refuse";
}> = [
  // Nothing referenced: nothing constrains the row, so the acting tenant stands.
  { what: "no referenced parent", referenced: [], fallback: "t_a", agreed: "t_a" },
  // A parent that is itself unstamped. The composite key is MATCH SIMPLE, so NULL
  // is the only value that satisfies it. Claiming `t_a` here is the 2026-08-07
  // production failure — three refused lead creations and two duplicate leads.
  // This is the TRANSITION case and it must keep working.
  { what: "one unstamped parent", referenced: [null], fallback: "t_a", agreed: null },
  { what: "two unstamped parents", referenced: [null, null], fallback: "t_a", agreed: null },
  { what: "one owned parent", referenced: ["t_a"], fallback: null, agreed: "t_a" },
  { what: "two parents that agree", referenced: ["t_a", "t_a"], fallback: null, agreed: "t_a" },
  // The two contradictions. Returning NULL here is what this rule used to do, and
  // NULL switches off BOTH composite foreign keys (MATCH SIMPLE) — so the detected
  // contradiction became an unowned row spanning two workspaces that the database
  // could no longer object to. There is no value that is true, so there is no write.
  { what: "two parents in different workspaces", referenced: ["t_a", "t_b"], fallback: "t_a", agreed: "refuse" },
  { what: "one owned parent and one unstamped", referenced: ["t_a", null], fallback: "t_a", agreed: "refuse" },
];

test("the operational rule answers agreement and REFUSES contradiction", () => {
  for (const row of RULE_TABLE) {
    if (row.agreed === "refuse") {
      assert.throws(
        () => rules.agreedTenantId(row.referenced, row.fallback),
        rules.TenantParentConflictError,
        `${row.what}: must refuse, not launder the contradiction into NULL`,
      );
      continue;
    }
    assert.equal(rules.agreedTenantId(row.referenced, row.fallback), row.agreed, row.what);
  }
});

test("the audit rule agrees everywhere except contradiction, where it degrades to NULL", () => {
  // AuditLog's deliberate exception: losing attribution on the log beats failing
  // the operation the log exists to record. Nothing else may use this.
  for (const row of RULE_TABLE) {
    const expected = row.agreed === "refuse" ? null : row.agreed;
    assert.equal(rules.bestEffortAgreedTenantId(row.referenced, row.fallback), expected, row.what);
    // And it never throws — that is the whole point of it existing.
    assert.doesNotThrow(() => rules.bestEffortAgreedTenantId(row.referenced, row.fallback));
  }
});

test("MUTATION CONTROL: reinstating return-NULL-on-disagreement goes red", () => {
  // The pre-2026-08-11 implementation, verbatim. If this passes the table above,
  // the table does not actually pin the fix and the regression can walk back in.
  const reinstated = (referenced: Array<string | null>, fallback: string | null) => {
    if (referenced.length === 0) return fallback;
    const first = referenced[0];
    return referenced.every((value) => value === first) ? first : null;
  };

  let caught = 0;
  for (const row of RULE_TABLE) {
    if (row.agreed !== "refuse") {
      // Everything the fixed rule ANSWERS, the old one answered identically — so the
      // difference below is located exactly at the contradictions and nowhere else.
      assert.equal(reinstated(row.referenced, row.fallback), row.agreed, row.what);
      continue;
    }
    // The old rule silently returns NULL where the fixed one refuses...
    assert.equal(reinstated(row.referenced, row.fallback), null, row.what);
    // ...so the assertion the real test makes must fail against it.
    assert.throws(
      () =>
        assert.throws(
          () => reinstated(row.referenced, row.fallback),
          rules.TenantParentConflictError,
        ),
      `${row.what}: the old rule must NOT satisfy the refusal assertion`,
    );
    caught++;
  }
  assert.equal(caught, 2, "both contradiction rows must be discriminating");
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The real resolver, against a fake database
 * ──────────────────────────────────────────────────────────────────────────── */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

const db = {
  contacts: new Map<string, { tenantId: string | null }>(),
  leads: new Map<string, { tenantId: string | null }>(),
  conversations: new Map<string, { tenantId: string | null }>(),
  communications: new Map<string, { tenantId: string | null }>(),
  activities: new Map<string, { tenantId: string | null }>(),
};

const finder = (store: Map<string, { tenantId: string | null }>) =>
  async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null;

const fakeClient = {
  contact: { findUnique: finder(db.contacts) },
  lead: { findUnique: finder(db.leads) },
  conversation: { findUnique: finder(db.conversations) },
  communication: { findUnique: finder(db.communications) },
  activity: { findUnique: finder(db.activities) },
};

/**
 * What `actingTenantId()` reports for the next call. Mutated per test.
 *
 * STUBBED, not loaded: `src/lib/actingTenant.ts` is not on this branch. It is being
 * landed by #459/#462 and reconciled separately, and this branch imports it as a
 * stated dependency rather than shipping a fourth copy of it. What is under test
 * here is what customerRecordTenant does AROUND it — the parent lookup and the
 * composite-key agreement rule — so the dependency is a stub with a knob on it.
 */
let acting: string | null = null;

const stubs: Record<string, unknown> = {
  "server-only": {},
  "./db": { basePrisma: fakeClient, prisma: fakeClient },
  "@/lib/db": { basePrisma: fakeClient, prisma: fakeClient },
  "./actingTenant": { actingTenantId: async () => acting },
  "@/lib/actingTenant": { actingTenantId: async () => acting },
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  // Anchored on the modules under test so nothing else in the tree is swapped.
  const from = parent?.filename ?? "";
  if (
    request in stubs &&
    (from.endsWith("customerRecordTenant.ts") || from.endsWith("timelinePins.ts"))
  ) {
    return stubs[request];
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const parentTenant = require_(
  "../src/lib/customerRecordTenant.ts",
) as typeof import("../src/lib/customerRecordTenant");

test("a child row inherits the tenant of the record it points at", async () => {
  acting = null;
  db.contacts.set("c_owned", { tenantId: "tenant_denago_cpt" });
  assert.equal(await parentTenant.customerRecordTenantId({ contactId: "c_owned" }), "tenant_denago_cpt");
});

test("a child of an UNSTAMPED parent stays unstamped rather than failing the write", async () => {
  // The composite key (tenantId, contactId) → Contact(tenantId, id) cannot be
  // satisfied by the acting tenant when the contact has none. Stamping anyway does
  // not mis-file the row, it REFUSES it — and the customer's message, activity or
  // booking is lost while the operator is told it failed.
  //
  // This is also why the parent lookup must not be routed through a helper that
  // substitutes an acting tenant for a null parent: it would put back exactly the
  // value the constraint rejects.
  acting = "tenant_denago_cpt";
  db.contacts.set("c_fresh", { tenantId: null });
  assert.equal(await parentTenant.customerRecordTenantId({ contactId: "c_fresh" }), null);
});

test("a row pointing into two workspaces is REFUSED, not written unowned", async () => {
  // The resolver must propagate the refusal rather than absorbing it. Returning NULL
  // here would write `tenantId=NULL, contactId=A's, leadId=B's` — and a NULL tenant
  // stops MATCH SIMPLE checking either composite key, so the one constraint that
  // would have caught a row spanning two workspaces is disabled by the value chosen
  // to satisfy it. `addCommunication()` authorises contactId and leadId
  // independently and then hands both here, so this is the backstop.
  acting = "tenant_a";
  db.contacts.set("c_a", { tenantId: "tenant_a" });
  db.leads.set("l_b", { tenantId: "tenant_b" });
  await assert.rejects(
    () => parentTenant.customerRecordTenantId({ contactId: "c_a", leadId: "l_b" }),
    rules.TenantParentConflictError,
  );
});

test("a partially-backfilled parent set is refused too", async () => {
  // One parent owned, one still unstamped. NULL would disable the composite check
  // against the OWNED parent; `tenant_a` would violate the key against the unowned
  // one. Neither is safe, so the write does not happen. (Both parents unstamped is
  // a different case and still resolves to NULL — see the rule table.)
  acting = "tenant_a";
  db.contacts.set("c_owned_a", { tenantId: "tenant_a" });
  db.leads.set("l_unstamped", { tenantId: null });
  await assert.rejects(
    () => parentTenant.customerRecordTenantId({ contactId: "c_owned_a", leadId: "l_unstamped" }),
    rules.TenantParentConflictError,
  );
});

test("with nothing referenced the acting tenant decides — including a cron's", async () => {
  // runCronPerTenant binds the founding tenant's scope even while enforcement is
  // dormant, and actingTenantId() reads it. `writeTenantId()` throws it away and
  // returns null, which is how these rows came to be unowned in the first place.
  acting = "tenant_denago_cpt";
  assert.equal(await parentTenant.customerRecordTenantId({}), "tenant_denago_cpt");
  assert.equal(
    await parentTenant.customerRecordTenantId({ contactId: null, leadId: undefined }),
    "tenant_denago_cpt",
  );
});

test("trusted cross-tenant work is left unattributed, never blamed on a tenant", async () => {
  // actingTenantId() answers null for a `system` scope; nothing here may override it.
  acting = null;
  assert.equal(await parentTenant.customerRecordTenantId({}), null);
});

test("an id that matches no row constrains nothing", async () => {
  // The insert will fail on its own single-column foreign key, which is the right
  // place for it to fail. Attribution must not be silently dropped because of it.
  acting = "tenant_denago_cpt";
  assert.equal(await parentTenant.customerRecordTenantId({ contactId: "c_missing" }), "tenant_denago_cpt");
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. TimelinePin — the raw INSERT the guard cannot see
 * ──────────────────────────────────────────────────────────────────────────── */

type CapturedSql = { text: string; values: unknown[] };
const executed: CapturedSql[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capture = async (query: any) => {
  executed.push({
    text: Array.isArray(query?.strings) ? query.strings.join("?") : String(query?.sql ?? query),
    values: query?.values ?? [],
  });
  return 1;
};

stubs["@/lib/db"] = {
  basePrisma: fakeClient,
  prisma: {
    ...fakeClient,
    $executeRaw: capture,
    $queryRaw: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({ $executeRaw: capture, $queryRaw: async () => [] }),
  },
};

const timelinePins = require_("../src/lib/timelinePins.ts") as typeof import("../src/lib/timelinePins");

test("a pin is written with the tenant of the item it pins", async () => {
  // 7 of 7 TimelinePin rows on production are unowned. The pin is written by raw
  // SQL, which the db.ts guard never sees, so the INSERT's own column list is the
  // only place ownership can be established.
  acting = null;
  executed.length = 0;
  db.activities.set("a_1", { tenantId: "tenant_denago_cpt" });

  await timelinePins.ensureTimelinePin("activity", "a_1", "u_1");

  assert.equal(executed.length, 1);
  assert.match(executed[0].text, /"tenantId"/, "the INSERT must name the tenantId column");
  assert.ok(
    executed[0].values.includes("tenant_denago_cpt"),
    `the pin must carry the pinned item's tenant, got ${JSON.stringify(executed[0].values)}`,
  );
});

test("a toggled-on pin carries the tenant too, and reads it from the right table", async () => {
  acting = null;
  executed.length = 0;
  db.contacts.set("c_note", { tenantId: "tenant_other" });

  // `contact_note` points into Contact, not Communication — the kind is what says
  // which table `itemId` means, and reading the wrong one attributes the pin to
  // nobody (or, with two tenants, to the wrong one).
  await timelinePins.toggleTimelinePin("contact_note", "c_note", "u_1");

  const insert = executed.find((entry) => /INSERT INTO "TimelinePin"/.test(entry.text));
  assert.ok(insert, "a pin that did not exist must be inserted");
  assert.match(insert.text, /"tenantId"/);
  assert.ok(insert.values.includes("tenant_other"));
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Source assertions — the writes no harness reaches
 * ──────────────────────────────────────────────────────────────────────────── */

/** The balanced `{ … }` argument object that starts after `from`. */
function argumentObject(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/**
 * Every top-level create/upsert of a tenant-owned customer record in `src/` has to
 * name `tenantId` in its payload — either inline, or through a variable holding it.
 *
 * A source assertion because the alternative is 25 integration harnesses, and
 * because the regression this guards against is textual: somebody adds the 26th
 * call site and copies one of the 25 that used to be right.
 */
const STAMPED_MODELS = ["communication", "activity"] as const;

/**
 * The `data:` value out of a create/upsert argument object, brackets balanced, so a
 * nested object or a ternary comes back whole and a sibling key (`select`, `where`)
 * never leaks in.
 */
function dataExpression(args: string): string {
  const key = args.search(/\bdata\s*:/);
  if (key === -1) return "";
  const start = args.indexOf(":", key) + 1;
  let depth = 0;
  for (let i = start; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === "{" || ch === "[" || ch === "(") depth += 1;
    else if (ch === "}" || ch === "]" || ch === ")") {
      if (depth === 0) return args.slice(start, i);
      depth -= 1;
    } else if (ch === "," && depth === 0) return args.slice(start, i);
  }
  return args.slice(start);
}

/**
 * The names that ARE the payload in a `data:` expression — not every name mentioned
 * in it. Only two shapes carry the payload: the expression is the variable itself
 * (including as a ternary branch), or the variable is spread into a new object.
 * Anything else in there — a condition, a property lookup, a helper call — is not
 * what gets written, and treating it as if it were makes this guard accept writes
 * that stamp nothing.
 */
function payloadNames(dataExpr: string): string[] {
  const names = new Set<string>();
  for (const spread of dataExpr.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) names.add(spread[1]);
  for (const branch of dataExpr.split(/[?:]/)) {
    const bare = branch.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
  }
  return [...names];
}

function unstampedWrites(rel: string): string[] {
  const source = shipped(rel);
  const missing: string[] = [];
  const call = new RegExp(`\\.(${STAMPED_MODELS.join("|")})\\.(create|upsert)\\(`, "g");
  for (const match of source.matchAll(call)) {
    const args = argumentObject(source, match.index + match[0].length - 1);
    if (/\btenantId\b/.test(args)) continue;
    /**
     * The payload is built above and referred to by name. Follow EVERY name the
     * `data:` expression mentions, not just a bare identifier: a write is equally
     * stamped whether it says `data: row`, `data: cond ? { ...row, k } : row`, or
     * `data: { ...row }`, and reading the last two as unstamped would be a false
     * alarm that teaches the next person to weaken this guard.
     *
     * Still narrow in the way that matters: only names appearing in this write's own
     * `data:` expression are followed, and only to a `const <name> = { … }` holding
     * `tenantId`. An unstamped write cannot borrow another write's variable, and it
     * cannot borrow an unrelated NAME either — following every identifier in the
     * expression accepted `data: decision.dedupeKey ? … : data` on the strength of
     * `const decision = decideEcho({ tenantId, … })`, which stamps nothing. Verified
     * by deleting the real stamp and watching this go red.
     */
    let stamped = false;
    for (const name of payloadNames(dataExpression(args))) {
      const decl = source.indexOf(`const ${name} =`);
      if (decl !== -1 && /\btenantId\b/.test(argumentObject(source, decl))) {
        stamped = true;
        break;
      }
    }
    if (stamped) continue;
    missing.push(`${rel}: ${match[1]}.${match[2]} at index ${match.index}`);
  }
  return missing;
}

const CUSTOMER_RECORD_WRITERS = [
  "src/app/actions/activities.ts",
  // The private reply to a public comment. Stamped from the THREAD's owner
  // rather than the acting scope, because Communication(tenantId,
  // conversationId) → Conversation(tenantId, id) is a composite key and the
  // thread is the side that already knows.
  "src/app/actions/comments.ts",
  "src/app/actions/communications.ts",
  "src/app/actions/emails.ts",
  "src/app/actions/fulfilment.ts",
  "src/app/actions/leads.ts",
  "src/app/actions/messenger.ts",
  "src/app/actions/portal.ts",
  "src/app/actions/testDrives.ts",
  "src/app/actions/warranty.ts",
  "src/app/actions/whatsapp.ts",
  "src/app/api/bookings/route.ts",
  "src/lib/bookingSlots.ts",
  "src/lib/bot.ts",
  // Inbound comments on posts and ads. Stamped from the channel scope the Page
  // id established, exactly as the DM and WhatsApp webhooks are.
  "src/lib/commentThreads.ts",
  "src/lib/botOutbox.ts",
  "src/lib/flowActions.ts",
  "src/lib/governedSurveyRuntime.ts",
  "src/lib/imapSync.ts",
  "src/lib/journeyStepExecutor.ts",
  "src/lib/messenger.ts",
  "src/lib/reviewRequests.ts",
  "src/lib/serviceReminders.ts",
  "src/lib/surveys.ts",
  "src/lib/whatsapp.ts",
] as const;

test("every Communication and Activity write names its owning tenant", () => {
  const missing = CUSTOMER_RECORD_WRITERS.flatMap(unstampedWrites);
  assert.deepEqual(
    missing,
    [],
    `these writes land with tenantId NULL and vanish at the flip:\n${missing.join("\n")}`,
  );
});

test("the writer list is the whole list", () => {
  // A file that starts writing Communication or Activity and is not listed above
  // would be unguarded, and the guard would still be green. Keep them in step.
  const call = new RegExp(`\\.(${STAMPED_MODELS.join("|")})\\.(create|upsert)\\(`);
  const writers = walk("src").filter((rel) => call.test(shipped(rel)));
  const unlisted = writers.filter((rel) => !CUSTOMER_RECORD_WRITERS.includes(rel as never));
  assert.deepEqual(unlisted, [], `unguarded Communication/Activity writers: ${unlisted.join(", ")}`);
});

test("the bookings API stamps the tenant its API key already resolved", () => {
  // The key authenticates to exactly one tenant and `establishTenantScopeFromId`
  // discards that while dormant, so every online booking landed unowned.
  const route = shipped("src/app/api/bookings/route.ts");
  assert.match(route, /const stampTid = writeTid \?\? auth\.tenantId;/);
  // …but the capacity count must NOT be narrowed by it: pre-existing NULL-tenant
  // bookings would become invisible to it and the slot would be double-booked.
  assert.match(route, /claimSlotCapacity\(tx, dt, config\.capacity, writeTid\)/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. The two models that are answered by a DECISION, not a stamp
 * ──────────────────────────────────────────────────────────────────────────── */

const guard = require_("../src/lib/tenantGuard.ts") as typeof import("../src/lib/tenantGuard");

test("ErrorLog is global on purpose, and its attribution shares one resolver", () => {
  // Either ErrorLog is global or it is tenant data; being neither is the only
  // wrong answer. It is GLOBAL: an error is most often raised where no tenant is
  // known, and a scoped model would fail that write closed under enforcement —
  // the system log would go dark exactly when the system is broken.
  assert.ok(guard.GLOBAL_MODELS.has("ErrorLog"));
  assert.equal(guard.isTenantScopedModel("ErrorLog"), false);
  // The attribution column is still filled best-effort, through the SAME resolver
  // every other write uses. A second copy of that decision is how it drifts.
  const errorLog = shipped("src/lib/errorLog.ts");
  assert.match(errorLog, /import \{ actingTenantId \} from "\.\/actingTenant"/);
  assert.doesNotMatch(
    errorLog,
    /getActiveTenantId|PLATFORM_SESSION_COOKIE/,
    "errorLog must not keep its own copy of the resolution order",
  );
});

test("an unattributed ErrorLog row is invisible to every workspace, not visible to all of them", () => {
  // This pins a FACT the prose got backwards. The claim used to be that a NULL-tenant
  // row is readable from every workspace's System Log — a cross-tenant leak, offered
  // as the accepted cost of ErrorLog being global. The code never did that: the read
  // matches an exact, resolved tenant id, so NULL rows match nothing and surface only
  // in the platform console. The real cost is discoverability, not confidentiality.
  const settings = shipped("src/app/(app)/settings/page.tsx");
  assert.match(
    settings,
    /errorLog\.findMany\(\{\s*where:\s*\{\s*tenantId:\s*logTenantId\s*\}/,
    "the System Log must read by exact tenant id",
  );
  // An `OR` reaching for null rows, or the filter going away, is the regression.
  assert.doesNotMatch(
    settings,
    /errorLog\.findMany\(\{\s*(orderBy|take|\})/,
    "the System Log must never read ErrorLog unfiltered",
  );
  assert.doesNotMatch(
    settings,
    /tenantId:\s*\{\s*in:\s*\[[^\]]*null/,
    "NULL-tenant errors belong to the platform console, not to a workspace",
  );
});

test("audit's forgiving conflict policy is a SEPARATE function, and only audit uses it", () => {
  // The whole point of two functions is that nobody reunifies them by accident.
  // `agreedTenantId` refuses a contradiction; `bestEffortAgreedTenantId` degrades to
  // NULL and is audit's exception alone. If an operational writer ever picks up the
  // forgiving one, a Communication or Activity can again be written unowned across
  // two workspaces with both composite keys disabled.
  assert.equal(typeof rules.agreedTenantId, "function");
  assert.equal(typeof rules.bestEffortAgreedTenantId, "function");

  // audit.ts is the ONE file entitled to it.
  assert.match(shipped("src/lib/audit.ts"), /bestEffortAgreedTenantId\(referenced, acting\)/);

  // The operational resolver every Communication/Activity writer goes through must
  // use the strict rule.
  const record = shipped("src/lib/customerRecordTenant.ts");
  assert.match(record, /return agreedTenantId\(referenced, null\)/);
  assert.doesNotMatch(record, /bestEffortAgreedTenantId/);

  // And nothing outside audit.ts may import it.
  // `shipped`, not `read`: customerRecordTenant.ts NAMES the audit exception in its
  // doc comment so the next reader knows it exists. Documenting a rule is not using it.
  const offenders = walk("src")
    .filter((rel) => rel !== "src/lib/audit.ts" && rel !== "src/lib/compositeTenantRules.ts")
    .filter((rel) => /bestEffortAgreedTenantId/.test(shipped(rel)));
  assert.deepEqual(offenders, [], "only audit may use the best-effort conflict policy");
});

test("BackupRun is global, so the Prisma model must carry no tenantId", () => {
  // Production has a tenantId column on this table that no migration here creates
  // and no code writes — schema drift, recorded in 20260806180000_rls_enforce_gap.
  // The audit reads its 13 NULL rows as a stamping bug; it is not one. This is the
  // invariant that keeps the two answers consistent.
  assert.ok(guard.GLOBAL_MODELS.has("BackupRun"));
  const model = read("prisma/schema.prisma").match(/model BackupRun \{[\s\S]*?\n\}/);
  assert.ok(model, "BackupRun must exist in the schema");
  assert.doesNotMatch(
    model[0],
    /tenantId/,
    "BackupRun is in GLOBAL_MODELS: giving it a tenantId makes the guard and the schema disagree",
  );
});
