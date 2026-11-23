-- Records the account's sessionVersion on each sign-in, so Sessions & devices can stop listing sign-ins that a
-- later "sign everyone out" (password reset, policy save, role change) has already ended. Additive, nullable.
ALTER TABLE "UserSession" ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER;
