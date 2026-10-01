/**
 * The staff password floor — one rule for every place a password is set:
 * adding a user, a new workspace's first owner, changing your own, and an owner
 * resetting a team member's. (It was copied into each "use server" file, which
 * can only export async functions.)
 */
export function validPassword(password: string): boolean {
  return password.length >= 12 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

export const PASSWORD_RULE = "at least 12 characters, with letters and numbers";
