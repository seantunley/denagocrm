import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  accountKey,
  dropSignInNote,
  forgetEmail,
  hasPasskeyHere,
  markPasskeyHere,
  notePasskeySignIn,
  notePasswordSignIn,
  promptSilencedFor,
  rememberedEmail,
  settleSignIn,
  silencePromptFor,
} from "../src/lib/passkeyDevice";

/**
 * The login page remembers a few things on the DEVICE (an email if asked,
 * "this account's passkey works here", "don't ask again"). These tests pin the
 * properties that make that safe on a public page: nothing about an account is
 * ever asked of the server, a failed sign-in looks the same whoever's account
 * it is, and on a shared computer one person's flags say nothing about the
 * next person's.
 */

const shipped = (rel: string) =>
  readFileSync(rel, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

async function withWindow(win: unknown, fn: () => void | Promise<void>) {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = win;
  try {
    await fn();
  } finally {
    g.window = before;
  }
}

test("the email is remembered only when ticked, and only once the app is reached", async () => {
  const local = fakeStorage();
  const session = fakeStorage();
  await withWindow({ localStorage: local, sessionStorage: session }, () => {
    notePasswordSignIn("sam@example.com", true);
    assert.equal(rememberedEmail(), "", "not stored at submit: the password may be wrong");
    assert.equal(settleSignIn(), "password");
    assert.equal(rememberedEmail(), "sam@example.com");
    assert.equal(settleSignIn(), null, "settled once");

    notePasswordSignIn("sam@example.com", false);
    assert.doesNotMatch(session.getItem("crm.login.signIn") ?? "", /sam@/, "unticked: the email is not even noted");
    settleSignIn();
    assert.equal(rememberedEmail(), "", "unticking forgets it");

    notePasswordSignIn("sam@example.com", true);
    dropSignInNote(); // a failed sign-in drops the note
    assert.equal(settleSignIn(), null);
    assert.equal(rememberedEmail(), "");

    // A passkey sign-in names nobody on the login page, and leaves the remembered email alone.
    local.setItem("crm.login.email", "sam@example.com");
    notePasskeySignIn();
    assert.doesNotMatch(session.getItem("crm.login.signIn") ?? "", /@/);
    assert.equal(settleSignIn(), "passkey");
    assert.equal(rememberedEmail(), "sam@example.com");

    session.setItem("crm.login.signIn", "{not json");
    assert.equal(settleSignIn(), null, "a garbled note is dropped, not trusted");
  });
});

test("passkey and don't-ask flags are per account, and hold a hash, never an email", async () => {
  const local = fakeStorage();
  await withWindow({ localStorage: local, sessionStorage: fakeStorage() }, async () => {
    assert.equal(await hasPasskeyHere("sam@example.com"), false);
    await markPasskeyHere("  Sam@Example.COM ");
    assert.equal(await hasPasskeyHere("sam@example.com"), true, "the same account however it was typed");
    assert.equal(await hasPasskeyHere("lee@example.com"), false, "a shared computer: Sam's passkey says nothing about Lee");
    assert.equal(await hasPasskeyHere(""), false, "no email, no account");

    await silencePromptFor("lee@example.com");
    assert.equal(await promptSilencedFor("lee@example.com"), true);
    assert.equal(await promptSilencedFor("sam@example.com"), false, "Lee's 'don't ask' does not silence Sam");

    assert.match(local.getItem("crm.passkey.accounts") ?? "", /^\["[0-9a-f]{64}"\]$/, "one SHA-256, hex");
    const everything = Array.from({ length: local.length }, (_, i) => local.getItem(local.key(i) ?? "")).join(" ");
    assert.doesNotMatch(everything, /@|sam|lee|example/i, "no email anywhere in the flags");
    assert.equal(await accountKey("Sam@Example.com"), await accountKey("sam@example.com"));

    await markPasskeyHere("sam@example.com");
    assert.equal(JSON.parse(local.getItem("crm.passkey.accounts") ?? "[]").length, 1, "marking twice adds nothing");
    for (let i = 0; i < 25; i++) await markPasskeyHere(`user${i}@example.com`);
    assert.equal(JSON.parse(local.getItem("crm.passkey.accounts") ?? "[]").length, 20, "bounded");
    assert.equal(await hasPasskeyHere("user24@example.com"), true, "newest kept");
    assert.equal(await hasPasskeyHere("sam@example.com"), false, "oldest dropped");
  });
});

test("only an email and flags are stored — never the password", () => {
  const src = shipped("src/lib/passkeyDevice.ts");
  assert.doesNotMatch(src, /password\s*[:,)]/i, "no password parameter or field");
  // The checkbox has no name, so it never reaches the server action either.
  const login = shipped("src/app/login/LoginClient.tsx");
  const checkbox = login.slice(login.indexOf('type="checkbox"') - 40, login.indexOf("Remember my email"));
  assert.doesNotMatch(checkbox, /name=/);
});

test("'Not you?' forgets, and blocked storage never throws", async () => {
  const local = fakeStorage();
  await withWindow({ localStorage: local, sessionStorage: fakeStorage() }, () => {
    local.setItem("crm.login.email", "sam@example.com");
    forgetEmail();
    assert.equal(rememberedEmail(), "");
  });

  const blocked = {
    get localStorage(): Storage {
      throw new Error("SecurityError");
    },
    get sessionStorage(): Storage {
      throw new Error("SecurityError");
    },
  };
  await withWindow(blocked, async () => {
    assert.equal(rememberedEmail(), "");
    notePasswordSignIn("a@b.c", true);
    assert.equal(settleSignIn(), null);
    forgetEmail();
    await markPasskeyHere("a@b.c");
    assert.equal(await hasPasskeyHere("a@b.c"), false);
    await silencePromptFor("a@b.c");
    assert.equal(await promptSilencedFor("a@b.c"), false);
  });
});

test("'passkey first' is decided on the device, per account: no server question about an email", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.doesNotMatch(login, /fetch\(/, "the login page itself asks the server nothing");
  assert.match(login, /const account = notYou \? "" : storedEmail;/, "the remembered account, until 'Not you?'");
  assert.match(login, /hasPasskeyHere\(account\)/);
  assert.doesNotMatch(login, /hasPasskeyHere\((email|typedEmail)\)/, "not the half-typed email: the form must not jump under someone's fingers");
  assert.match(login, /const accountUsedPasskey = Boolean\(account\) && flaggedAccount === account;/);
  assert.match(login, /platformAuthenticatorAvailable\(\)/);
  const device = shipped("src/lib/passkeyDevice.ts");
  assert.match(device, /isUserVerifyingPlatformAuthenticatorAvailable\(\)/);
  assert.match(device, /crypto\.subtle\.digest\("SHA-256"/);
  const fetches = [...device.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ["/api/auth/passkey/register/options", "/api/auth/passkey/register/verify"], "only registration, which needs a session");
  // Flags are set only where a passkey really was used or created, against the account that did it.
  assert.match(device, /options\?\.user\?\.name/, "registration: the server's own options name the account");
  assert.match(device, /if \(!verifyRes\.ok\) throw[^\n]*\r?\n\s*await markPasskeyHere\(account\);/);
  const button = shipped("src/components/PasskeyLoginButton.tsx");
  assert.match(button, /notePasskeySignIn\(\);/);
  assert.doesNotMatch(button, /markPasskeyHere/, "the login page cannot know whose passkey it was");
});

test("a failed sign-in shows one message and the same hints, whoever's account it is", () => {
  const actions = shipped("src/app/login/actions.ts");
  const loginFn = actions.slice(actions.indexOf("export async function login"), actions.indexOf("async function sendLoginEmailCode"));
  assert.equal([...loginFn.matchAll(/return \{ error: "Invalid email or password\." \}/g)].length, 1, "one failure message for unknown and wrong");

  const login = shipped("src/app/login/LoginClient.tsx");
  const block = login.slice(login.indexOf('id="login-error"'), login.indexOf('type="submit"', login.indexOf('id="login-error"')));
  assert.match(block, /Try a passkey instead/);
  assert.match(block, /Reset password/);
  assert.doesNotMatch(block, /state\.error\s*(===|!==|\.includes|\.startsWith)|state\.(methods|need2fa)/, "hints must not branch on what the server said");
});

test("input polish, pending and focus", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.match(login, /inputMode="email"/);
  assert.match(login, /aria-describedby=\{state\?\.error \? "login-error" : undefined\}/);
  assert.match(login, /<fieldset disabled=\{pending\}/, "fields locked while signing in");
  assert.match(login, /LoaderCircle className="size-4 animate-spin"/, "spinner on the button");
  assert.match(login, /if \(!state\?\.error\) return;\s*dropSignInNote\(\);\s*passwordRef\.current\?\.focus\(\);/, "failure → password");
  // (The 2FA auto-send is pinned in secondFactorEntry.test.ts.)
});

test("after a failed attempt the tick box shows what will actually happen", () => {
  // React resets the form after every attempt. It keeps a controlled text
  // box's reset value in step, but sets a controlled checkbox's defaultChecked
  // only on first render, so the reset could show the box unticked while the
  // state still said "remember". The page keeps the two equal itself.
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.match(login, /useEffect\(\(\) => \{\s*if \(rememberRef\.current\) rememberRef\.current\.defaultChecked = remember;\s*\}, \[remember\]\);/);
  assert.match(login, /ref=\{rememberRef\}\s*type="checkbox"\s*checked=\{remember\}/);
  assert.match(login, /value=\{email\}/, "the email box is controlled, so React keeps it through the reset");
});

test("phones: passkey leads, but the password only folds away for an account whose passkey has worked here", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.match(login, /const passkeyFirst = platformReader && \(accountUsedPasskey \|\| isPwa\);/);
  assert.match(
    login,
    /const foldPassword = passkeyFirst && accountUsedPasskey && !wantsPassword && !state\?\.error;/,
    "a phone that merely SUPPORTS passkeys, or someone else's passkey on a shared device: never hide the only way in",
  );
  assert.match(login, /Use password instead/);
  assert.match(login, /className=\{foldPassword \? \(isPwa \? "hidden" : "max-sm:hidden"\) : undefined\}/, "phones only (any width in the installed app)");
});

test("phones: keyboard, safe areas, touch targets, inputs", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.match(login, /autoComplete="username"/);
  assert.match(login, /autoCapitalize="none"/);
  assert.match(login, /autoComplete="current-password"/);
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(login, new RegExp(`env\\(safe-area-inset-${side}\\)`), `respects the ${side} safe area`);
  }
  assert.match(shipped("src/app/login/page.tsx"), /viewportFit: "cover"/, "without it every inset is 0");
  assert.doesNotMatch(shipped("src/app/layout.tsx"), /viewportFit/, "the rest of the app is not opted in");
  assert.match(login, /min-h-11[^"`]*whitespace-nowrap[^"`]*`\}\s*>\s*Forgot password\?/, "44px hit area");
  assert.match(login, /<span className="hidden sm:inline">v\{APP_VERSION\}<\/span>/, "no version on phones");
  assert.match(login, /sm:my-auto sm:py-14 short:my-0 short:py-3/, "top-aligned on phones and short screens");
  assert.match(readFileSync("src/app/globals.css", "utf8"), /@custom-variant short \(@media \(max-height: 520px\)\);/);
  // The error sits at the top of the form, before the fields.
  assert.ok(login.indexOf('id="login-error"') < login.indexOf('id="email"'), "error above the fields");
});

test("decoration stays decoration, and the pulse folds on tablets", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  const scene = login.slice(login.indexOf("function BrandScene"));
  assert.match(scene, /aria-hidden="true"/);
  assert.match(login, /aria-hidden="true" className=\{`[^`]*rounded-full[^`]*`\}>Secure access/);
  const strip = login.slice(login.indexOf("function PulseStrip"), login.indexOf("function Metric"));
  assert.match(strip, /aria-hidden="true" className="[^"]*hidden md:block lg:hidden/, "tablet portrait only");
  assert.doesNotMatch(strip, /brand\.|props|fetch|prisma/, "fixed illustrative figures, never data");
  assert.match(shipped("src/app/login/page.tsx"), /<LoginClient brand=\{brand\} \/>/, "still only the brand is passed in");
});

test("the 'add a passkey' prompt is per signed-in account, and can be silenced per account", () => {
  assert.match(shipped("src/app/(app)/layout.tsx"), /<AddPasskeyPrompt email=\{user\.email\} \/>/, "the session's own account");
  const prompt = shipped("src/components/AddPasskeyPrompt.tsx");
  assert.match(prompt, /export default function AddPasskeyPrompt\(\{ email \}: \{ email: string \}\)/);
  assert.match(prompt, /if \(how === "passkey"\) void markPasskeyHere\(email\);/, "a passkey sign-in is recorded against the account that made it");
  assert.match(prompt, /if \(how !== "password"\) return;/, "offered only after a password sign-in");
  assert.match(prompt, /\(await hasPasskeyHere\(email\)\) \|\| \(await promptSilencedFor\(email\)\)/);
  assert.match(prompt, /silencePromptFor\(email\)/);
  assert.match(prompt, /registerPasskey\(/, "the same registration flow as My Account");
  assert.match(shipped("src/components/PasskeyManager.tsx"), /registerPasskey\(nickname\)/);
  assert.doesNotMatch(prompt, /role="dialog"|aria-modal/, "non-blocking");
});
