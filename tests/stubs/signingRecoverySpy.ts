/**
 * An in-memory stand-in for the slice of Prisma, mail and storage that the
 * signing completion/recovery path touches, so the SHIPPED functions can be RUN
 * instead of read.
 *
 * It is not a Prisma emulator. It implements only the query shapes those
 * functions actually use — `AND`/`OR`, equality, `lt`, `in`, `null`, the
 * `events: { none: ... }` relation filter, `orderBy`, `take`, `select`,
 * `findMany`/`findFirst`/`findUnique`/`count`/`create`/`updateMany` — and
 * anything outside that THROWS rather than quietly matching nothing, so a future
 * query shape cannot pass here by being silently misunderstood.
 *
 * Two things it models deliberately, because they are the subject of the tests:
 *
 *   1. `prisma` HIDES soft-deleted rows and `basePrisma` does not. That
 *      difference is the whole of the "the blob check ignored the filed
 *      Document" finding, and a spy that ignored it could not fail on it.
 *   2. `sendEmail` returns `{ ok }` and never throws, exactly like the real one,
 *      and records the tenant scope in force at the moment of the send — which
 *      is what decides whose SMTP credentials a real send would use.
 */
import { currentTenantScope } from "@/lib/tenantScope";

export type Row = Record<string, unknown>;

export type ModelName =
  | "signatureRequest"
  | "signatureRecipient"
  | "signatureEvent"
  | "quote"
  | "lead"
  | "jobCard"
  | "document";

const MODELS: ModelName[] = [
  "signatureRequest",
  "signatureRecipient",
  "signatureEvent",
  "quote",
  "lead",
  "jobCard",
  "document",
];

/** Models the filtered client hides soft-deleted rows for, mirroring SOFT_DELETE_MODELS. */
const SOFT_DELETED: ReadonlySet<ModelName> = new Set([
  "signatureRequest",
  "quote",
  "lead",
  "jobCard",
  "document",
]);

type Tables = Record<ModelName, Row[]>;

const tables: Tables = {
  signatureRequest: [],
  signatureRecipient: [],
  signatureEvent: [],
  quote: [],
  lead: [],
  jobCard: [],
  document: [],
};

export type EmailCall = {
  to: string;
  subject: string;
  attachments: number;
  /** The tenant whose SMTP identity a real send would have used. */
  tenantId: string | null | undefined;
};

export type ErrorCall = { scope: string; message: string; context?: string };

export const emails: EmailCall[] = [];
export const errors: ErrorCall[] = [];
export const audits: Row[] = [];
export const journeyEvents: Array<{ type: string; leadId: string; occurrence?: string }> = [];
export const referrals: string[] = [];
export const pushes: Row[] = [];

/** Programmable outcomes for the collaborators the code cannot control. */
export const behaviour = {
  /** Addresses `sendEmail` refuses. Every other address succeeds. */
  emailFailsFor: new Set<string>(),
  /** When set, `readFile` throws this instead of returning bytes. */
  readFileThrows: null as Error | null,
  /** When set, `logAudit` throws — the swallowed-failure case. */
  auditThrows: null as Error | null,
  /** When set, `emitLeadJourneyEvent` throws. */
  journeyThrows: null as Error | null,
};

export function reset(seed: Partial<Tables> = {}): void {
  for (const model of MODELS) tables[model] = [...(seed[model] ?? [])].map((r) => ({ ...r }));
  emails.length = 0;
  errors.length = 0;
  audits.length = 0;
  journeyEvents.length = 0;
  referrals.length = 0;
  pushes.length = 0;
  behaviour.emailFailsFor = new Set();
  behaviour.readFileThrows = null;
  behaviour.auditThrows = null;
  behaviour.journeyThrows = null;
}

export function rows(model: ModelName): Row[] {
  return tables[model];
}

/* ── where matching ──────────────────────────────────────────────────────── */

function matchOperators(value: unknown, condition: Record<string, unknown>): boolean {
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case "equals":
        if (!sameValue(value, operand)) return false;
        break;
      case "lt":
        if (!(value instanceof Date) || !(operand instanceof Date) || !(value < operand)) return false;
        break;
      case "gt":
        if (!(value instanceof Date) || !(operand instanceof Date) || !(value > operand)) return false;
        break;
      case "in":
        if (!Array.isArray(operand) || !operand.some((o) => sameValue(value, o))) return false;
        break;
      case "notIn":
        if (!Array.isArray(operand) || operand.some((o) => sameValue(value, o))) return false;
        break;
      case "not":
        if (sameValue(value, operand)) return false;
        break;
      default:
        throw new Error(`signingRecoverySpy: unsupported operator "${op}"`);
    }
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

function matches(model: ModelName, row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [field, condition] of Object.entries(where)) {
    if (field === "AND") {
      const list = (Array.isArray(condition) ? condition : [condition]) as Row[];
      if (!list.every((c) => matches(model, row, c))) return false;
      continue;
    }
    if (field === "OR") {
      const list = (Array.isArray(condition) ? condition : [condition]) as Row[];
      if (!list.some((c) => matches(model, row, c))) return false;
      continue;
    }
    if (field === "NOT") {
      if (matches(model, row, condition as Row)) return false;
      continue;
    }
    // The one relation filter the sweep uses: "this request has no completed event".
    if (field === "events") {
      const spec = condition as { none?: Row };
      if (!spec || !spec.none) throw new Error("signingRecoverySpy: only `events: { none: … }` is supported");
      const related = tables.signatureEvent.filter((e) => e.requestId === row.id);
      if (related.some((e) => matches("signatureEvent", e, spec.none))) return false;
      continue;
    }
    const value = row[field];
    if (
      condition !== null &&
      typeof condition === "object" &&
      !(condition instanceof Date) &&
      !Array.isArray(condition)
    ) {
      if (!matchOperators(value, condition as Record<string, unknown>)) return false;
      continue;
    }
    if (!sameValue(value, condition)) return false;
  }
  return true;
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((f) => [f, row[f] ?? null]));
}

function sort(found: Row[], orderBy?: Record<string, "asc" | "desc">): Row[] {
  if (!orderBy) return found;
  const entries = Object.entries(orderBy);
  if (entries.length !== 1) throw new Error("signingRecoverySpy: one orderBy key only");
  const [field, direction] = entries[0];
  return [...found].sort((a, b) => {
    const left = a[field] instanceof Date ? (a[field] as Date).getTime() : Number(a[field]);
    const right = b[field] instanceof Date ? (b[field] as Date).getTime() : Number(b[field]);
    return direction === "desc" ? right - left : left - right;
  });
}

type FindArgs = {
  where?: Row;
  orderBy?: Record<string, "asc" | "desc">;
  take?: number;
  select?: Record<string, boolean>;
  include?: Record<string, unknown>;
};

/**
 * `hideSoftDeleted` is what separates the two exported clients. The filtered
 * `prisma` drops trashed rows; `basePrisma` returns them. Getting that
 * difference wrong in the real code is how a live Document ends up with its blob
 * deleted, so the spy has to reproduce it faithfully.
 */
function model(name: ModelName, hideSoftDeleted: boolean) {
  const visible = () =>
    hideSoftDeleted && SOFT_DELETED.has(name)
      ? tables[name].filter((r) => !r.deletedAt)
      : tables[name];

  return {
    findMany(args: FindArgs = {}): Promise<Row[]> {
      const found = sort(visible().filter((r) => matches(name, r, args.where)), args.orderBy);
      const limited = args.take === undefined ? found : found.slice(0, args.take);
      return Promise.resolve(limited.map((r) => project(r, args.select)));
    },
    findFirst(args: FindArgs = {}): Promise<Row | null> {
      const found = sort(visible().filter((r) => matches(name, r, args.where)), args.orderBy);
      return Promise.resolve(found.length ? project(found[0], args.select) : null);
    },
    findUnique(args: FindArgs = {}): Promise<Row | null> {
      const found = visible().filter((r) => matches(name, r, args.where));
      return Promise.resolve(found.length ? project(found[0], args.select) : null);
    },
    count(args: FindArgs = {}): Promise<number> {
      return Promise.resolve(visible().filter((r) => matches(name, r, args.where)).length);
    },
    create(args: { data: Row }): Promise<Row> {
      const row = { id: `${name}-${tables[name].length + 1}`, createdAt: new Date(), ...args.data };
      tables[name].push(row);
      return Promise.resolve({ ...row });
    },
    updateMany(args: { where?: Row; data: Row }): Promise<{ count: number }> {
      const hit = visible().filter((r) => matches(name, r, args.where));
      for (const row of hit) Object.assign(row, args.data);
      return Promise.resolve({ count: hit.length });
    },
  };
}

function client(hideSoftDeleted: boolean) {
  return Object.fromEntries(MODELS.map((m) => [m, model(m, hideSoftDeleted)])) as Record<
    ModelName,
    ReturnType<typeof model>
  >;
}

/** The filtered client — soft-deleted rows are invisible, as in db.ts. */
export const prisma = client(true);
/** The trusted bypass client — nothing is hidden, as in db.ts. */
export const basePrisma = client(false);

/* ── collaborators ───────────────────────────────────────────────────────── */

/** Same contract as the real one: `{ ok }`, and it NEVER throws. */
export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
  attachments?: unknown[];
}): Promise<{ ok: boolean; error?: string }> {
  emails.push({
    to: input.to,
    subject: input.subject,
    attachments: input.attachments?.length ?? 0,
    tenantId: currentTenantScope()?.tenantId,
  });
  if (behaviour.emailFailsFor.has(input.to)) {
    return { ok: false, error: "550 mailbox unavailable" };
  }
  return { ok: true };
}

export async function readFile(): Promise<Buffer> {
  if (behaviour.readFileThrows) throw behaviour.readFileThrows;
  return Buffer.from("%PDF-1.7 sealed");
}

export async function logError(scope: string, err: unknown, context?: string): Promise<void> {
  errors.push({ scope, message: err instanceof Error ? err.message : String(err), context });
}

export async function logAudit(entry: Row): Promise<void> {
  if (behaviour.auditThrows) throw behaviour.auditThrows;
  audits.push(entry);
}

export async function emitLeadJourneyEvent(
  type: string,
  leadId: string,
  opts?: { occurrence?: string },
): Promise<void> {
  if (behaviour.journeyThrows) throw behaviour.journeyThrows;
  journeyEvents.push({ type, leadId, occurrence: opts?.occurrence });
}

export async function markReferralEarned(leadId: string): Promise<void> {
  referrals.push(leadId);
}

export async function sendPushToAll(payload: Row): Promise<void> {
  pushes.push(payload);
}
