import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { SOFT_DELETE_MODELS } from "../src/lib/softDeleteModels";

// Guard: the filtered `prisma` client only hides / refuses trashed rows for models
// it knows about. If a model gains a `deletedAt` column but isn't registered, its
// trashed rows silently resolve and stay mutable through the filtered client
// (exactly the DocTemplateRecord gap). These tests fail the build if the registry
// and the schema ever drift, in either direction.

function modelsWithDeletedAt(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "deletedAt"))
    .map((model) => model.name);
}

test("every model with a deletedAt column is registered in SOFT_DELETE_MODELS", () => {
  const missing = modelsWithDeletedAt().filter((name) => !SOFT_DELETE_MODELS.has(name));
  assert.deepEqual(
    missing,
    [],
    `Models with a deletedAt column missing from SOFT_DELETE_MODELS: ${missing.join(", ")}`,
  );
});

test("SOFT_DELETE_MODELS has no entries that lack a deletedAt column", () => {
  const withDeletedAt = new Set(modelsWithDeletedAt());
  const stale = [...SOFT_DELETE_MODELS].filter((name) => !withDeletedAt.has(name));
  assert.deepEqual(
    stale,
    [],
    `SOFT_DELETE_MODELS entries with no deletedAt column (renamed/removed model?): ${stale.join(", ")}`,
  );
});
