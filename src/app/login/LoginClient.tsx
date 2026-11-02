"use client";
import BrandLogo from "@/components/BrandLogo";

import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { ArrowRight, Check, Eye, EyeOff, Fingerprint, LoaderCircle, LockKeyhole, ShieldCheck, Zap } from "lucide-react";
import { APP_VERSION } from "@/lib/version";
import PasskeyLoginButton, { usePasskeySignIn } from "@/components/PasskeyLoginButton";
import {
  dropPasswordSignIn,
  forgetEmail,
  notePasswordSignIn,
  passkeyOnThisDevice,
  platformAuthenticatorAvailable,
  rememberedEmail,
} from "@/lib/passkeyDevice";
import { login, requestEmailCode, type LoginState, verifySecondFactor } from "./actions";
import { requestPasswordReset, resetPasswordWithCode, type ResetState } from "./resetActions";
import type { LoginBrand } from "@/lib/loginBrand";

/**
 * EVERY brand substitution below is gated on `brand.branded`, and the false
 * branch is the ORIGINAL LITERAL — not a value computed from UNBRANDED that
 * happens to match. That distinction is the point: it makes "an unbranded login
 * page is byte-for-byte what shipped before" something a test can check by
 * reading this file, rather than something that holds until someone edits the
 * default. See tests/loginBranding.test.ts.
 */
export default function LoginClient({ brand }: { brand: LoginBrand }) {
  return (
    <Suspense>
      <LoginInner brand={brand} />
    </Suspense>
  );
}

/** Nothing here changes while the page is open: read once, no subscription. */
const noSubscribe = () => () => {};

function LoginInner({ brand }: { brand: LoginBrand }) {
  const isPwa = useSyncExternalStore(subscribeToDisplayMode, getDisplayModeSnapshot, () => false);
  const [showPassword, setShowPassword] = useState(false);
  const [state, formAction, pending] = useActionState<LoginState | undefined, FormData>(login, undefined);
  const [forgot, setForgot] = useState(false);
  const timedOut = useSearchParams().get("timeout") === "1";
  const passkey = usePasskeySignIn(isPwa);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Remembered on THIS device only, and only if they ticked the box last time.
  const storedEmail = useSyncExternalStore(noSubscribe, rememberedEmail, () => "");
  const [typedEmail, setTypedEmail] = useState<string | null>(null);
  const [rememberChoice, setRememberChoice] = useState<boolean | null>(null);
  const email = typedEmail ?? storedEmail;
  const remember = rememberChoice ?? Boolean(storedEmail);

  // Passkey first where this device has a fingerprint/face/PIN reader AND either
  // has signed in with (or registered) a passkey before, or is the installed app.
  // Decided on the device only. Never asks the server: "does this email have a
  // passkey?" would tell a stranger the account exists.
  const usedPasskeyHere = useSyncExternalStore(noSubscribe, passkeyOnThisDevice, () => false);
  const [platformReader, setPlatformReader] = useState(false);
  useEffect(() => {
    let live = true;
    void platformAuthenticatorAvailable().then((available) => {
      if (live) setPlatformReader(available);
    });
    return () => {
      live = false;
    };
  }, []);
  const passkeyFirst = platformReader && (usedPasskeyHere || isPwa);
  // On a phone (any width in the installed app) the password form folds behind
  // "Use password instead" — but ONLY where a passkey has worked here before.
  // A phone that merely supports passkeys may have none, and then the password
  // is the only way in.
  const [wantsPassword, setWantsPassword] = useState(false);
  const foldPassword = passkeyFirst && usedPasskeyHere && !wantsPassword && !state?.error;

  // A remembered email means the password is the next thing to type.
  useEffect(() => {
    if (storedEmail) passwordRef.current?.focus();
  }, [storedEmail]);

  // After ANY failure: back to the password (the email is usually right), and
  // forget the note that a password sign-in was on its way.
  useEffect(() => {
    if (!state?.error) return;
    dropPasswordSignIn();
    passwordRef.current?.focus();
  }, [state]);

  if (state?.need2fa) return <TwoFactorStep methods={state.methods ?? []} brand={brand} />;
  if (forgot) return <ForgotPasswordStep brand={brand} onBack={() => setForgot(false)} />;

  const passkeyButton = <PasskeyLoginButton passkey={passkey} disabled={pending} />;
  const divider = (text: string) =>
    passkey.supported ? (
      <div className="my-5 flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-slate-600">
        <span className="h-px flex-1 bg-slate-800" />
        {text}
        <span className="h-px flex-1 bg-slate-800" />
      </div>
    ) : null;
  const linkButton =
    "cursor-pointer rounded text-xs text-slate-500 underline-offset-4 outline-none transition hover:text-slate-200 hover:underline focus-visible:text-slate-200 focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#070909]";
  const errorAction =
    "inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-red-300/20 bg-red-300/10 px-3.5 text-xs font-medium text-red-100 outline-none transition hover:bg-red-300/15 hover:text-white focus-visible:ring-2 focus-visible:ring-red-300/50";

  return (
    <Shell brand={brand}>
      <div className="mb-6 sm:mb-8 short:mb-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-primary short:hidden">Staff portal</p>
        <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl short:text-2xl">Welcome back.</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400 short:hidden">{`Sign in to ${brand.displayName}.`}</p>
      </div>

      {timedOut && (
        <div role="status" className="mb-4 flex gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/8 px-4 py-3 text-sm text-amber-100">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <div>
            <span>Your secure session ended. Sign in again to continue.</span>
            {passkey.supported && (
              <button
                type="button"
                onClick={passkey.signIn}
                disabled={passkey.busy || pending}
                className="mt-1.5 flex cursor-pointer items-center gap-1.5 rounded text-xs font-medium text-amber-200 underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-amber-300/50 disabled:opacity-60"
              >
                <Fingerprint className="size-3.5" />
                Sign in with passkey
              </button>
            )}
          </div>
        </div>
      )}

      <div className={state?.error ? "animate-shake" : undefined}>
        {passkeyFirst && (
          <>
            {passkeyButton}
            {foldPassword ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setWantsPassword(true);
                    requestAnimationFrame(() => (storedEmail ? passwordRef : emailRef).current?.focus());
                  }}
                  className={`${isPwa ? "flex" : "flex sm:hidden"} mt-3 min-h-11 w-full cursor-pointer items-center justify-center rounded-2xl text-sm font-medium text-slate-400 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-primary/50`}
                >
                  Use password instead
                </button>
                {!isPwa && <div className="hidden sm:block">{divider("or use your password")}</div>}
              </>
            ) : (
              divider("or use your password")
            )}
          </>
        )}
        <form
          action={formAction}
          onSubmit={() => notePasswordSignIn(email.trim().toLowerCase(), remember)}
          aria-busy={pending}
          className={foldPassword ? (isPwa ? "hidden" : "max-sm:hidden") : undefined}
        >
          {/* Disabled while signing in, so a second tap or Enter can't send it twice. */}
          <fieldset disabled={pending} className="space-y-5 short:space-y-3">
            <input type="hidden" name="pwa" value={isPwa ? "1" : "0"} />
            {/* At the TOP of the form, so a short screen with the keyboard open
                still shows it. The SAME hints for every failure: they must not
                say whether the account exists. */}
            {state?.error && (
              <div role="alert" id="login-error" className="rounded-xl border border-red-400/15 bg-red-400/8 px-3 py-2.5 text-sm text-red-300">
                <p>{state.error}</p>
                <p className="mt-2 flex flex-wrap gap-2">
                  {passkey.supported && (
                    <button type="button" onClick={passkey.signIn} className={errorAction}>
                      Try a passkey instead
                    </button>
                  )}
                  <button type="button" onClick={() => setForgot(true)} className={errorAction}>
                    Reset password
                  </button>
                </p>
              </div>
            )}
            <Field
              label="Work email"
              htmlFor="email"
              aside={
                storedEmail && email === storedEmail ? (
                  <button
                    type="button"
                    className={`${linkButton} -my-3 -mr-2 px-2 py-3`}
                    onClick={() => {
                      forgetEmail();
                      setTypedEmail("");
                      setRememberChoice(false);
                      emailRef.current?.focus();
                    }}
                  >
                    Not you?
                  </button>
                ) : null
              }
            >
              <input
                ref={emailRef}
                id="email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="you@example.com"
                className="login-input"
                value={email}
                onChange={(event) => setTypedEmail(event.target.value)}
                autoFocus
                required
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <div className="relative">
                <input
                  ref={passwordRef}
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="login-input pr-12"
                  aria-invalid={state?.error ? true : undefined}
                  aria-describedby={state?.error ? "login-error" : undefined}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-xl text-slate-500 outline-none transition hover:text-slate-200 focus-visible:text-slate-200 focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  {showPassword ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
                </button>
              </div>
              {/* Both at least 44px tall to the finger, with room between them. */}
              <div className="mt-1 flex items-center justify-between gap-4">
                <label
                  title="Fills in your email next time on this device. You still sign in every time."
                  className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-slate-500"
                >
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => setRememberChoice(event.target.checked)}
                    className="size-3.5 accent-[var(--primary)]"
                  />
                  Remember my email
                </label>
                <button
                  type="button"
                  onClick={() => setForgot(true)}
                  className={`${linkButton} -mr-2 inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-2`}
                >
                  Forgot password?
                </button>
              </div>
            </Field>
            <button type="submit" className="login-submit group">
              <span>{pending ? "Signing you in…" : "Enter workspace"}</span>
              {pending ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              )}
            </button>
          </fieldset>
        </form>

        {!passkeyFirst && (
          <>
            {divider("or")}
            {passkeyButton}
          </>
        )}
      </div>

      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-500">
        <LockKeyhole className="size-3.5" />
        <span>Protected with encrypted, secure sessions</span>
      </div>
    </Shell>
  );
}

function Field({ label, htmlFor, aside, children }: { label: string; htmlFor: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label htmlFor={htmlFor} className="block text-[13px] font-medium text-slate-300">
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}

/**
 * "Forgot password?": email → 6-digit code + new password (see resetActions.ts).
 * The first answer is the same whether or not the account exists.
 */
function ForgotPasswordStep({ brand, onBack }: { brand: LoginBrand; onBack: () => void }) {
  const [requested, requestAction, requesting] = useActionState<ResetState | undefined, FormData>(requestPasswordReset, undefined);
  const [reset, resetAction, resetting] = useActionState<ResetState | undefined, FormData>(resetPasswordWithCode, undefined);
  const email = reset?.email ?? requested?.email ?? "";
  const onCodeStep = Boolean(requested?.sent || reset?.sent);
  const error = reset?.error ?? requested?.error;

  return (
    <Shell brand={brand}>
      <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-[0_0_35px_color-mix(in_oklab,var(--primary)_12%,transparent)]">
        <LockKeyhole className="size-6" />
      </div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-primary">Reset password</p>
      {reset?.done ? (
        <>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">Password changed.</h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">You&apos;ve been signed out everywhere. Sign in with your new password.</p>
          <button type="button" onClick={onBack} className="login-submit mt-8">
            Back to sign in
            <ArrowRight className="size-4" />
          </button>
        </>
      ) : !onCodeStep ? (
        <>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">Forgot your password?</h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">Enter the email you sign in with and we&apos;ll email you a code.</p>
          <form action={requestAction} className={`mt-8 space-y-4 ${error ? "animate-shake" : ""}`}>
            <Field label="Work email" htmlFor="reset-email">
              <input id="reset-email" name="email" type="email" autoComplete="email" autoFocus required className="login-input" placeholder="you@example.com" />
            </Field>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <button type="submit" className="login-submit" disabled={requesting}>
              {requesting ? "Sending…" : "Email me a code"}
              <ArrowRight className="size-4" />
            </button>
          </form>
        </>
      ) : (
        <>
          <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">Check your email.</h1>
          <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">
            If {email} has an account, a 6-digit code is on its way. It expires in 15 minutes.
          </p>
          <form action={resetAction} className={`mt-8 space-y-4 ${error ? "animate-shake" : ""}`}>
            <input type="hidden" name="email" value={email} />
            <Field label="Code" htmlFor="reset-code">
              <input id="reset-code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} required className="login-input text-center font-mono text-xl tracking-[0.42em]" placeholder="••••••" />
            </Field>
            <Field label="New password" htmlFor="reset-password">
              <input id="reset-password" name="password" type="password" autoComplete="new-password" minLength={12} required className="login-input" placeholder="At least 12 characters, letters and numbers" />
            </Field>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
            <button type="submit" className="login-submit" disabled={resetting}>
              {resetting ? "Saving…" : "Set new password"}
              <ArrowRight className="size-4" />
            </button>
          </form>
        </>
      )}
      {!reset?.done && (
        <button type="button" onClick={onBack} className="mt-4 w-full cursor-pointer py-2 text-center text-xs text-slate-500 transition hover:text-slate-200">
          Back to sign in
        </button>
      )}
    </Shell>
  );
}

function TwoFactorStep({ methods, brand }: { methods: string[]; brand: LoginBrand }) {
  const [state, formAction, pending] = useActionState<{ error?: string } | undefined, FormData>(verifySecondFactor, undefined);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const hasTotp = methods.includes("totp");
  const hasEmail = methods.includes("email");
  const submitRef = useRef<HTMLButtonElement>(null);
  const autoSubmit = useRef<number | undefined>(undefined);

  return (
    <Shell brand={brand}>
      <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-[0_0_35px_color-mix(in_oklab,var(--primary)_12%,transparent)]">
        <ShieldCheck className="size-6" />
      </div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-primary">Identity check</p>
      <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">One more step.</h1>
      <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">
        {hasTotp ? "Enter the six-digit code from your authenticator app." : "Enter the code we sent to your email."}
      </p>

      <div className={`mt-8 ${state?.error ? "animate-shake" : ""}`}>
        <form action={formAction} onSubmit={() => window.clearTimeout(autoSubmit.current)} className="space-y-4">
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={12}
            aria-label="Verification code"
            className="login-input h-14 text-center font-mono text-xl tracking-[0.42em]"
            placeholder="••••••"
            required
            onChange={(event) => {
              // Six digits sends itself. After a short pause, not at once: a
              // backup code (8 hex characters) typed without its hyphen can
              // start with six digits, and an early send would spend one of the
              // limited attempts on half a code. Clicking the (disabled while
              // pending) button means it can never send twice.
              window.clearTimeout(autoSubmit.current);
              if (/^\d{6}$/.test(event.target.value.trim())) {
                autoSubmit.current = window.setTimeout(() => submitRef.current?.click(), 600);
              }
            }}
          />
          {state?.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
          <button ref={submitRef} type="submit" className="login-submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify and continue"}
            {pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
          </button>
          {hasEmail && (
            <button
              type="button"
              disabled={sending}
              onClick={async () => {
                setSending(true);
                await requestEmailCode();
                setSent(true);
                setSending(false);
              }}
              className="w-full cursor-pointer py-2 text-center text-xs text-slate-500 transition hover:text-slate-200 disabled:cursor-wait"
            >
              {sending ? "Sending…" : sent ? "Code sent — check your inbox" : hasTotp ? "Use an email code instead" : "Resend email code"}
            </button>
          )}
          {hasTotp && <p className="text-center text-[11px] text-slate-600">Backup codes work here too.</p>}
        </form>
      </div>
    </Shell>
  );
}

function Shell({ children, brand }: { children: React.ReactNode; brand: LoginBrand }) {
  const isPwa = useSyncExternalStore(subscribeToDisplayMode, getDisplayModeSnapshot, () => false);
  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[#070909] text-white lg:grid lg:grid-cols-[minmax(430px,0.82fr)_1.18fr]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,color-mix(in_oklab,var(--primary)_11%,transparent),transparent_32%)] lg:hidden" />
      {/*
        * Padding is "the design's value, or the notch/home indicator if that is
        * bigger" on every side. The breakpoints only change the design's value
        * (--pad-x / --pad-y), so the safe-area rule is written once. The
        * installed app and short (landscape) screens get a tighter top and
        * bottom so the submit button stays above the keyboard.
        */}
      <section
        className={`relative z-10 flex min-h-[100dvh] flex-col ${isPwa ? "[--pad-y:0.75rem]" : "[--pad-y:1rem]"} [--pad-x:1.5rem] sm:[--pad-x:2.5rem] sm:[--pad-y:1.75rem] lg:[--pad-x:3.5rem] xl:[--pad-x:5rem] short:[--pad-y:0.75rem] pt-[max(var(--pad-y),env(safe-area-inset-top))] pr-[max(var(--pad-x),env(safe-area-inset-right))] pb-[max(var(--pad-y),env(safe-area-inset-bottom))] pl-[max(var(--pad-x),env(safe-area-inset-left))]`}
      >
        <header className="flex items-center justify-between">
          {/*
            * A tenant logo is an arbitrary uploaded image with no recorded
            * intrinsic size, streamed from our own route — next/image needs
            * dimensions we do not have. The height class bounds it either way.
            *
            * With no logo this sets the workspace NAME rather than the built-in
            * asset, which was one customer's wordmark shown on every other
            * customer's login page — see BrandLogo.
            */}
          <BrandLogo
            logoUrl={brand.logoUrl}
            alt={brand.displayName}
            className={isPwa ? "h-7 w-auto object-contain" : "h-8 w-auto object-contain sm:h-9"}
            wordmarkClassName="text-sm text-white sm:text-base"
          />
          {/* Decoration (the real security line is under the button), so not on phones or in the installed app. */}
          <span aria-hidden="true" className={`${isPwa ? "hidden" : "hidden sm:inline-block"} rounded-full border border-white/8 bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500`}>Secure access</span>
        </header>
        {/* Phones and short screens: the form sits near the top, so the keyboard
            does not push the button off screen. sm and up: centred. */}
        <div className="w-full max-w-[420px] self-center pb-8 pt-6 sm:my-auto sm:py-14 short:my-0 short:py-3">
          {children}
          <PulseStrip />
        </div>
        <footer className="mt-auto flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-slate-700 sm:mt-0 short:mt-auto">
          <span>{brand.displayName}</span>
          <span className="hidden sm:inline">v{APP_VERSION}</span>
        </footer>
      </section>
      <BrandScene brand={brand} />
    </main>
  );
}

function BrandScene({ brand }: { brand: LoginBrand }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(0.5);
  const mouseY = useMotionValue(0.5);
  const x = useSpring(mouseX, { stiffness: 45, damping: 20 });
  const y = useSpring(mouseY, { stiffness: 45, damping: 20 });
  const cardX = useTransform(x, [0, 1], [-12, 12]);
  const cardY = useTransform(y, [0, 1], [-9, 9]);
  const glowX = useTransform(x, [0, 1], [35, -35]);
  const glowY = useTransform(y, [0, 1], [20, -20]);

  return (
    <section
      ref={ref}
      onMouseMove={(event) => {
        if (reduced || !ref.current) return;
        const bounds = ref.current.getBoundingClientRect();
        mouseX.set((event.clientX - bounds.left) / bounds.width);
        mouseY.set((event.clientY - bounds.top) / bounds.height);
      }}
      // Pure decoration: illustrative figures, never real data (the page is public).
      aria-hidden="true"
      className="relative hidden overflow-hidden border-l border-white/[0.06] bg-[#0c0f0e] lg:block"
    >
      <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] [background-size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]" />
      <div className="absolute -right-28 -top-28 size-[500px] rounded-full border border-primary/10" />
      <div className="absolute -right-12 -top-12 size-[330px] rounded-full border border-primary/10" />
      <motion.div style={{ x: glowX, y: glowY }} className="absolute right-[8%] top-[12%] size-80 rounded-full bg-primary/20 blur-[110px]" />

      <div className="relative flex h-full min-h-[680px] flex-col justify-between p-12 xl:p-16">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" /><span className="relative size-2 rounded-full bg-emerald-400" /></span>
            Operations online
          </div>
          <Zap className="size-5 text-primary" fill="currentColor" />
        </div>

        <div className="relative mx-auto w-full max-w-3xl py-14">
          <motion.div style={{ x: cardX, y: cardY }} className="relative rounded-[32px] border border-white/10 bg-white/[0.055] p-7 shadow-[0_40px_120px_rgba(0,0,0,.5)] backdrop-blur-xl xl:p-9">
            <div className="mb-10 flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Today’s pulse</p>
                <p className="mt-2 text-2xl font-medium tracking-tight">{brand.displayName}</p>
              </div>
              {brand.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt="" className="h-12 w-auto object-contain drop-shadow-[0_12px_25px_color-mix(in_oklab,var(--primary)_28%,transparent)]" />
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Metric value="14" label="Active leads" accent />
              <Metric value="6" label="Open quotes" />
              <Metric value="3" label="Follow-ups" />
            </div>
            <div className="mt-7 rounded-2xl border border-white/[0.06] bg-black/20 p-4">
              <div className="mb-5 flex items-center justify-between text-xs"><span className="text-slate-400">Team momentum</span><span className="text-emerald-400">+18% this week</span></div>
              <div className="flex h-20 items-end gap-2">
                {[38, 52, 44, 68, 58, 82, 72, 96, 84, 100].map((height, index) => <div key={height + index} className={`flex-1 rounded-t-sm ${index === 9 ? "bg-primary" : "bg-white/10"}`} style={{ height: `${height}%` }} />)}
              </div>
            </div>
            <div className="absolute -bottom-5 -right-5 flex items-center gap-3 rounded-2xl border border-white/10 bg-[#171a18]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
              <span className="flex size-8 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400"><Check className="size-4" /></span>
              <div><p className="text-xs font-medium">Follow-up complete</p><p className="mt-0.5 text-[10px] text-slate-500">Customer journey updated</p></div>
            </div>
          </motion.div>
        </div>

        <div>
          {/* Any business's words, not one dealer's ("Every vehicle. One electric
              rhythm." was Denago's, shown to every workspace). */}
          <p className="max-w-xl text-3xl font-medium leading-tight tracking-[-0.035em] text-white xl:text-4xl">Every lead. Every customer.<br /><span className="text-slate-500">All in one place.</span></p>
          <p className="mt-4 max-w-md text-sm leading-6 text-slate-500">{brand.tagline ?? `The command centre for ${brand.displayName}: leads, customers and the follow-ups that keep them.`}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * Tablet portrait (md up to lg): "Today's pulse" folded down to its three
 * numbers, where the full panel has no room. The SAME fixed illustrative
 * figures as the big panel — this page is public, so it never shows real
 * workspace data. Hidden on phones and from screen readers.
 */
function PulseStrip() {
  return (
    <div aria-hidden="true" className="mt-10 hidden md:block lg:hidden">
      <p className="mb-3 text-[10px] uppercase tracking-[0.22em] text-slate-600">Today’s pulse</p>
      <div className="grid grid-cols-3 gap-3">
        <Metric value="14" label="Active leads" accent />
        <Metric value="6" label="Open quotes" />
        <Metric value="3" label="Follow-ups" />
      </div>
    </div>
  );
}

function Metric({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return <div className={`rounded-2xl border p-4 ${accent ? "border-primary/20 bg-primary/10" : "border-white/[0.06] bg-white/[0.025]"}`}><p className={`text-2xl font-semibold ${accent ? "text-primary" : "text-white"}`}>{value}</p><p className="mt-1 text-[11px] text-slate-500">{label}</p></div>;
}

function subscribeToDisplayMode(onChange: () => void) {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getDisplayModeSnapshot() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
