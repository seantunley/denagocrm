import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import {
  dontAskForPasskey,
  dropPasswordSignIn,
  forgetEmail,
  markPasskeyOnThisDevice,
  notePasswordSignIn,
  passkeyOnThisDevice,
  rememberedEmail,
  settlePasswordSignIn,
  stopAskingForPasskey,
} from "../src/lib/passkeyDevice";

/**
 * The login page remembers a few things on the DEVICE (an email if asked, "a
 * passkey lives here", "don't ask again"). These tests pin the two properties
 * that make that safe on a public page: nothing about an account is ever asked
 * of the server, and a failed sign-in looks the same whoever's account it is.
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

function withWindow(win: unknown, fn: () => void) {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = win;
  try {
    fn();
  } finally {
    g.window = before;
  }
}

test("the email is remembered only when ticked, and only once the app is reached", () => {
  const local = fakeStorage();
  const session = fakeStorage();
  withWindow({ localStorage: local, sessionStorage: session }, () => {
    notePasswordSignIn("sam@example.com", true);
    assert.equal(rememberedEmail(), "", "not stored at submit: the password may be wrong");
    assert.equal(settlePasswordSignIn(), true);
    assert.equal(rememberedEmail(), "sam@example.com");
    assert.equal(settlePasswordSignIn(), false, "settled once");

    notePasswordSignIn("sam@example.com", false);
    assert.doesNotMatch(session.getItem("crm.login.passwordSignIn") ?? "", /sam@/, "unticked: the email is not even noted");
    settlePasswordSignIn();
    assert.equal(rememberedEmail(), "", "unticking forgets it");

    notePasswordSignIn("sam@example.com", true);
    dropPasswordSignIn(); // a failed sign-in drops the note
    assert.equal(settlePasswordSignIn(), false);
    assert.equal(rememberedEmail(), "");
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

test("'Not you?', passkey flags and don't-ask work, and blocked storage never throws", () => {
  const local = fakeStorage();
  withWindow({ localStorage: local, sessionStorage: fakeStorage() }, () => {
    local.setItem("crm.login.email", "sam@example.com");
    forgetEmail();
    assert.equal(rememberedEmail(), "");
    assert.equal(passkeyOnThisDevice(), false);
    markPasskeyOnThisDevice();
    assert.equal(passkeyOnThisDevice(), true);
    assert.equal(dontAskForPasskey(), false);
    stopAskingForPasskey();
    assert.equal(dontAskForPasskey(), true);
  });

  const blocked = {
    get localStorage(): Storage {
      throw new Error("SecurityError");
    },
    get sessionStorage(): Storage {
      throw new Error("SecurityError");
    },
  };
  withWindow(blocked, () => {
    assert.equal(rememberedEmail(), "");
    assert.equal(passkeyOnThisDevice(), false);
    notePasswordSignIn("a@b.c", true);
    assert.equal(settlePasswordSignIn(), false);
    forgetEmail();
    markPasskeyOnThisDevice();
    stopAskingForPasskey();
  });
});

test("'passkey first' is decided on the device: no server question about an email", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.doesNotMatch(login, /fetch\(/, "the login page itself asks the server nothing");
  assert.match(login, /useSyncExternalStore\(noSubscribe, passkeyOnThisDevice,/);
  assert.match(login, /platformAuthenticatorAvailable\(\)/);
  const device = shipped("src/lib/passkeyDevice.ts");
  assert.match(device, /isUserVerifyingPlatformAuthenticatorAvailable\(\)/);
  const fetches = [...device.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(fetches, ["/api/auth/passkey/register/options", "/api/auth/passkey/register/verify"], "only registration, which needs a session");
  // The flag is set only where a passkey really was used or created on this device.
  assert.match(shipped("src/components/PasskeyLoginButton.tsx"), /markPasskeyOnThisDevice\(\)/);
  assert.match(device, /if \(!verifyRes\.ok\) throw[^\n]*\r?\n\s*markPasskeyOnThisDevice\(\);/);
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
  assert.match(login, /if \(!state\?\.error\) return;\s*dropPasswordSignIn\(\);\s*passwordRef\.current\?\.focus\(\);/, "failure → password");
  assert.match(login, /\/\^\\d\{6\}\$\/\.test/, "2FA sends itself at six digits");
  assert.match(login, /submitRef\.current\?\.click\(\)/, "through the button, which is disabled while pending");
});

test("phones: passkey leads, but the password only folds away where a passkey has worked here", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  assert.match(login, /const passkeyFirst = platformReader && \(usedPasskeyHere \|\| isPwa\);/);
  assert.match(
    login,
    /const foldPassword = passkeyFirst && usedPasskeyHere && !wantsPassword && !state\?\.error;/,
    "a phone that merely SUPPORTS passkeys may have none: never hide the only way in",
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

test("the 'add a passkey' prompt is mounted in the signed-in app and can be silenced", () => {
  assert.match(shipped("src/app/(app)/layout.tsx"), /<AddPasskeyPrompt \/>/);
  const prompt = shipped("src/components/AddPasskeyPrompt.tsx");
  assert.match(prompt, /if \(!settlePasswordSignIn\(\)\) return;/, "only after a password sign-in");
  assert.match(prompt, /passkeyOnThisDevice\(\) \|\| dontAskForPasskey\(\)/);
  assert.match(prompt, /stopAskingForPasskey\(\)/);
  assert.match(prompt, /registerPasskey\(/, "the same registration flow as My Account");
  assert.match(shipped("src/components/PasskeyManager.tsx"), /registerPasskey\(nickname\)/);
  assert.doesNotMatch(prompt, /role="dialog"|aria-modal/, "non-blocking");
});
