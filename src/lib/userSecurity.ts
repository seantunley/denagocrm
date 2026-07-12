import { cache } from "react";
import { basePrisma } from "./db";

export type UserSecurityState = {
  sessionVersion: number;
  disabledAt: Date | null;
  lastLoginAt: Date | null;
  failedLoginCount: number;
};

const DEFAULT_STATE: UserSecurityState = {
  sessionVersion: 0,
  disabledAt: null,
  lastLoginAt: null,
  failedLoginCount: 0,
};

// Request-memoised: read the row once per request even when getCurrentUser and
// direct callers both ask. Request-scoped, so changes apply on the next request.
export const getUserSecurityState = cache(async (userId: string): Promise<UserSecurityState | null> => {
  try {
    const rows = await basePrisma.$queryRaw<UserSecurityState[]>`
      SELECT "sessionVersion", "disabledAt", "lastLoginAt", "failedLoginCount"
      FROM "User"
      WHERE "id" = ${userId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  } catch {
    // Before migration 47 is applied, preserve the existing sign-in path. Once
    // the columns exist, all security-state reads are authoritative.
    const rows = await basePrisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${userId} LIMIT 1
    `;
    return rows[0] ? DEFAULT_STATE : null;
  }
});

export async function bumpUserSessionVersion(userId: string): Promise<number> {
  const rows = await basePrisma.$queryRaw<Array<{ sessionVersion: number }>>`
    UPDATE "User"
    SET "sessionVersion" = "sessionVersion" + 1
    WHERE "id" = ${userId}
    RETURNING "sessionVersion"
  `;
  if (!rows[0]) throw new Error("User not found");
  return rows[0].sessionVersion;
}

export async function recordSuccessfulLogin(userId: string): Promise<number> {
  const rows = await basePrisma.$queryRaw<Array<{ sessionVersion: number }>>`
    UPDATE "User"
    SET "lastLoginAt" = CURRENT_TIMESTAMP, "failedLoginCount" = 0
    WHERE "id" = ${userId} AND "disabledAt" IS NULL
    RETURNING "sessionVersion"
  `;
  if (!rows[0]) throw new Error("User is disabled or no longer exists");
  return rows[0].sessionVersion;
}

export async function recordFailedLogin(userId: string): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "User"
    SET "failedLoginCount" = "failedLoginCount" + 1
    WHERE "id" = ${userId}
  `;
}

export async function setUserDisabledState(userId: string, disabled: boolean): Promise<number> {
  const rows = await basePrisma.$queryRaw<Array<{ sessionVersion: number }>>`
    UPDATE "User"
    SET "disabledAt" = ${disabled ? new Date() : null},
        "sessionVersion" = "sessionVersion" + 1
    WHERE "id" = ${userId}
    RETURNING "sessionVersion"
  `;
  if (!rows[0]) throw new Error("User not found");
  return rows[0].sessionVersion;
}
