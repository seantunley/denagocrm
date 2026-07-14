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
  "DocBuilderTemplate",
  "SignatureRequest",
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
