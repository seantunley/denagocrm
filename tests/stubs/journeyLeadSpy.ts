/**
 * An in-memory Lead table and a recorder for the fan-out, so the SHIPPED
 * `executeJourneyStep` can be RUN rather than read.
 *
 * `journeyStepExecutor.ts` reaches the database, the mail provider, SMS, push
 * and the audit trail, so the tests that mattered most about it — does a retry
 * re-apply, can it close another workspace's deal — were written as source
 * greps: "is `markReferralEarned` textually after the `applied` gate". A grep
 * cannot tell whether the gate is REACHED, only whether it is written down, and
 * the two come apart the moment the surrounding control flow changes.
 *
 * This is not a Prisma emulator. It implements exactly the query shapes the
 * lead-writing steps use, and `matches` mirrors the one semantic that the whole
 * tenant argument rests on: `tenantId: null` is `IS NULL`, a real predicate, and
 * NOT "no filter". A fake that treated null as a wildcard would make the
 * cross-tenant test pass for the wrong reason.
 *
 * Anything a step asks for that is not implemented THROWS, so a new query shape
 * cannot pass here by being silently misunderstood.
 */

export type LeadRow = {
  id: string;
  tenantId: string | null;
  status: string;
  lostReason: string | null;
  deletedAt: Date | null;
  stageId?: string | null;
  position?: number;
  assignedToId?: string | null;
};

type Where = Record<string, unknown>;

export type LeadCall = { op: "updateMany" | "aggregate"; where: Where; data?: Record<string, unknown> };

/** One recorded fan-out call: which effect, and the arguments it was given. */
export type Effect = { name: string; args: unknown[] };

let table: LeadRow[] = [];

/** Every Lead query the executor made, in order. */
export const leadCalls: LeadCall[] = [];
/** Every side effect the executor fired, in order. */
export const effects: Effect[] = [];

export function reset(rows: LeadRow[] = []) {
  table = rows.map((row) => ({ ...row }));
  leadCalls.length = 0;
  effects.length = 0;
}

export function rows(): LeadRow[] {
  return table;
}

export function row(id: string): LeadRow {
  const found = table.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`journeyLeadSpy: no seeded lead "${id}"`);
  return found;
}

/** The names of the effects fired, in order — the shape most assertions want. */
export function firedNames(): string[] {
  return effects.map((effect) => effect.name);
}

export function fired(name: string): Effect[] {
  return effects.filter((effect) => effect.name === name);
}

function matches(candidate: LeadRow, where: Where): boolean {
  for (const [field, condition] of Object.entries(where)) {
    const value = (candidate as Record<string, unknown>)[field] ?? null;
    if (condition !== null && typeof condition === "object" && !(condition instanceof Date)) {
      const entries = Object.entries(condition as Record<string, unknown>);
      for (const [op, operand] of entries) {
        if (op !== "in") throw new Error(`journeyLeadSpy: unsupported operator "${op}" on "${field}"`);
        if (!Array.isArray(operand) || !operand.includes(value)) return false;
      }
      continue;
    }
    // Strict equality, null included. This is the line the tenant tests rest on.
    if (value !== (condition ?? null)) return false;
  }
  return true;
}

/** A recorder that stands in for one module the executor fans out to. */
function record(name: string) {
  return (...args: unknown[]) => {
    effects.push({ name, args });
    return Promise.resolve();
  };
}

export const prisma = {
  lead: {
    updateMany(args: { where: Where; data: Record<string, unknown> }): Promise<{ count: number }> {
      leadCalls.push({ op: "updateMany", where: args.where, data: args.data });
      const matched = table.filter((candidate) => matches(candidate, args.where));
      for (const hit of matched) Object.assign(hit, args.data);
      return Promise.resolve({ count: matched.length });
    },
    aggregate(args: { where: Where }): Promise<{ _max: { position: number | null } }> {
      leadCalls.push({ op: "aggregate", where: args.where });
      const matched = table.filter((candidate) => matches(candidate, args.where));
      const positions = matched.map((hit) => hit.position ?? 0);
      return Promise.resolve({ _max: { position: positions.length ? Math.max(...positions) : null } });
    },
  },
};

/**
 * The modules the executor fans out to, each one recording rather than doing.
 *
 * `logAudit` is the audit trail, `markReferralEarned` makes a referral fee due
 * and `emitLeadJourneyEvent` re-enters the journey engine — all three are
 * things that must happen exactly once per real transition and never on a
 * retry, which is what the tests using this assert.
 */
export const modules: Record<string, Record<string, unknown>> = {
  "./audit": { logAudit: record("logAudit"), logAuditStrict: record("logAuditStrict") },
  "./referrals": { markReferralEarned: record("markReferralEarned") },
  "./leadJourneyEvents": { emitLeadJourneyEvent: record("emitLeadJourneyEvent") },
  "./journeyEvents": { emitJourneyEvent: record("emitJourneyEvent") },
  "./push": { sendPushToAll: record("sendPushToAll") },
  "./sms": { sendSms: record("sendSms") },
  "./tenantActor": { resolveTenantActor: () => Promise.resolve({ id: "user_1" }) },
  "./communicationPolicy": {
    canContactPerson: () => Promise.resolve({ allowed: true }),
    nextCommunicationWindow: () => new Date(),
  },
  "./nextStepConfig": { getNextStepScheduling: () => Promise.resolve(null) },
};
