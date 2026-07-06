"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createSessionCookie, destroySessionCookie } from "@/lib/auth";

// Brute-force protection: max 5 failed attempts per account per 15 minutes.
// In-memory is fine for a single-instance deployment.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const failedAttempts = new Map<string, { count: number; first: number }>();

function isLockedOut(key: string): boolean {
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string) {
  const entry = failedAttempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    failedAttempts.set(key, { count: 1, first: Date.now() });
  } else {
    entry.count++;
  }
}

export async function login(
  _prev: { error?: string } | undefined,
  formData: FormData
): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) return { error: "Email and password are required." };

  if (isLockedOut(email)) {
    return {
      error: "Too many failed attempts. Try again in 15 minutes.",
    };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    recordFailure(email);
    return { error: "Invalid email or password." };
  }

  failedAttempts.delete(email);
  await createSessionCookie(user);
  redirect("/");
}

export async function logout() {
  await destroySessionCookie();
  redirect("/login");
}
