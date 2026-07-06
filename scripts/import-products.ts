/**
 * Imports the real Denago Cape Town vehicle range (from denagocpt.co.za)
 * into the products catalog. Safe to re-run: upserts by product name.
 *
 *   npx tsx scripts/import-products.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const RANGE = [
  {
    name: "Denago EV City Cart",
    sku: "city-cart",
    basePriceCents: 35_000_000,
    description: "5 seats · 100 km range · From R350,000 incl. VAT",
    colors: [],
  },
  {
    name: "Denago EV Scout 2",
    sku: "scout-2",
    basePriceCents: 16_000_000,
    description: "2 seats · 64 km range · From R160,000 incl. VAT",
    colors: [],
  },
  {
    name: "Denago EV Scout 4",
    sku: "scout-4",
    basePriceCents: 17_000_000,
    description: "4 seats · 64 km range · From R170,000 incl. VAT",
    colors: [],
  },
  {
    name: "Denago EV Nomad",
    sku: "nomad",
    basePriceCents: 0,
    description: "4 seats (2+2, non-lifted) · 64 km range · Pricing on enquiry",
    colors: ["Champagne", "Gray", "White", "Black", "Blue", "Lava"],
  },
  {
    name: "Denago EV Nomad XL",
    sku: "nomad-xl",
    basePriceCents: 22_000_000,
    description: "4 seats (2+2, lifted) · 64 km range · From R220,000 incl. VAT",
    colors: ["Champagne", "Gray", "White", "Black", "Blue", "Lava"],
  },
  {
    name: "Denago EV Rover XL",
    sku: "rover-xl",
    basePriceCents: 23_500_000,
    description:
      "4 seats forward-facing (lifted) · 64 km range · From R235,000 incl. VAT · Most popular",
    colors: ["Gray", "Lava", "White", "Black", "Blue", "Verdant"],
  },
  {
    name: "Denago EV Rover XL 6",
    sku: "rover-xl-6",
    basePriceCents: 27_000_000,
    description: "6 seats (4+2, lifted) · 52 km range · From R270,000 incl. VAT",
    colors: ["Gray", "Lava", "White", "Black", "Blue", "Verdant"],
  },
  {
    name: "Denago EV Rover XXL",
    sku: "rover-xxl",
    basePriceCents: 27_000_000,
    description:
      "6 seats forward-facing (lifted) · 52 km range · From R270,000 incl. VAT",
    colors: ["Gray", "Scarlet", "White", "Black", "Blue", "Verdant", "Lava"],
  },
];

const SAMPLE_NAMES = [
  "Denago City Model 1",
  "Denago Commute Model 1",
  "Denago Fat Tire Step-Thru",
];

async function main() {
  // Remove the placeholder sample products if nothing references them
  for (const name of SAMPLE_NAMES) {
    const sample = await prisma.product.findFirst({
      where: { name },
      include: { _count: { select: { leads: true, vehicles: true } } },
    });
    if (sample && sample._count.leads === 0 && sample._count.vehicles === 0) {
      await prisma.product.delete({ where: { id: sample.id } });
      console.log(`Removed sample product: ${name}`);
    }
  }

  for (const p of RANGE) {
    const existing = await prisma.product.findFirst({ where: { name: p.name } });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: {
          sku: p.sku,
          category: "Electric utility vehicle",
          basePriceCents: p.basePriceCents,
          description: p.description,
          active: true,
          colors: { deleteMany: {}, create: p.colors.map((name) => ({ name })) },
        },
      });
      console.log(`Updated: ${p.name}`);
    } else {
      await prisma.product.create({
        data: {
          name: p.name,
          sku: p.sku,
          category: "Electric utility vehicle",
          basePriceCents: p.basePriceCents,
          description: p.description,
          colors: { create: p.colors.map((name) => ({ name })) },
        },
      });
      console.log(`Created: ${p.name}`);
    }
  }

  const count = await prisma.product.count();
  console.log(`Done. ${count} products in catalog.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
