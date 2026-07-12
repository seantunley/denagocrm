import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  basePrisma?: PrismaClient;
  prisma?: ReturnType<typeof buildClient>;
};

/** Models with soft-delete (Trash) support. */
const SOFT_DELETE_MODELS = new Set([
  "Contact",
  "Lead",
  "Vehicle",
  "JobCard",
  "Document",
  "Product",
  "LibraryDocument",
  "Quote",
  "StockUnit",
  "PurchaseOrder",
  "Part",
  "Survey",
  "Fleet",
  "CustomDocTemplate",
  "DocInstance",
  "ReusableBlock",
]);

/* eslint-disable @typescript-eslint/no-explicit-any */
function addAliveFilter(model: string, args: any) {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  args = args ?? {};
  const where = args.where ?? {};
  // an explicit deletedAt filter (e.g. the Trash page) wins
  if (!("deletedAt" in where)) {
    args.where = { ...where, deletedAt: null };
  }
  return args;
}

function buildClient(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async findFirst({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async count({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async aggregate({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
        async groupBy({ model, args, query }: any) {
          return query(addAliveFilter(model, args));
        },
      },
      // Shared inbox: attach every new message to a conversation and roll its
      // counters/unread forward. Best-effort — conversation bookkeeping must
      // never fail a Communication write. Uses basePrisma internally (no recursion).
      communication: {
        async create({ args, query }: any) {
          let conversationId: string | null = null;
          try {
            const { resolveConversationId } = await import("./conversations");
            conversationId = await resolveConversationId(args.data);
            if (conversationId && !args.data.conversationId) args.data.conversationId = conversationId;
          } catch {
            conversationId = null;
          }
          const result = await query(args);
          if (conversationId) {
            try {
              const { bumpConversation } = await import("./conversations");
              await bumpConversation(conversationId, args.data);
            } catch {
              /* bookkeeping is best-effort */
            }
          }
          return result;
        },
      },
    },
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Raw client without the soft-delete filter — for backups, trash, and purge. */
export const basePrisma = globalForPrisma.basePrisma ?? new PrismaClient();

/** Default client: soft-deleted records are hidden from list/count queries. */
export const prisma = globalForPrisma.prisma ?? buildClient(basePrisma);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.basePrisma = basePrisma;
  globalForPrisma.prisma = prisma;
}
