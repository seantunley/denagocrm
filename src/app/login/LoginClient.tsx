"use client";

import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Suspense, useActionState, useRef, useState, useSyncExternalStore } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion";
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, ShieldCheck, Zap } from "lucide-react";
import { APP_VERSION } from "@/lib/version";
import PasskeyLoginButton from "@/components/PasskeyLoginButton";
import { login, requestEmailCode, type LoginState, verifySecondFactor } from "./actions";
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

function LoginInner({ brand }: { brand: LoginBrand }) {
  const isPwa = useSyncExternalStore(subscribeToDisplayMode, getDisplayModeSnapshot, () => false);
  const [showPassword, setShowPassword] = useState(false);
  const [state, formAction, pending] = useActionState<LoginState | undefined, FormData>(login, undefined);
  const timedOut = useSearchParams().get("timeout") === "1";

  if (state?.need2fa) return <TwoFactorStep methods={state.methods ?? []} brand={brand} />;

  return (
    <Shell brand={brand}>
      <div className="mb-8">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-orange-400">Staff portal</p>
        <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl">Welcome back.</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">{brand.branded ? `Sign in to ${brand.displayName}.` : "Sign in to keep Cape Town moving."}</p>
      </div>

      {timedOut && (
        <div role="status" className="mb-4 flex gap-3 rounded-2xl border border-amber-300/15 bg-amber-300/8 px-4 py-3 text-sm text-amber-100">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-400" />
          <span>Your secure session ended. Sign in again to continue.</span>
        </div>
      )}

      <div className={state?.error ? "animate-shake" : undefined}>
        <form action={formAction} className="space-y-5">
          <input type="hidden" name="pwa" value={isPwa ? "1" : "0"} />
          <Field label="Work email" htmlFor="email">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder={brand.branded ? "you@example.com" : "you@denagocpt.co.za"}
              className="login-input"
              autoFocus
              required
            />
          </Field>
          <Field label="Password" htmlFor="password">
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Enter your password"
                className="login-input pr-12"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-slate-500 transition hover:text-slate-200"
              >
                {showPassword ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
              </button>
            </div>
          </Field>
          {state?.error && (
            <p role="alert" className="rounded-xl border border-red-400/15 bg-red-400/8 px-3 py-2.5 text-sm text-red-300">
              {state.error}
            </p>
          )}
          <button type="submit" className="login-submit group" disabled={pending}>
            <span>{pending ? "Signing you in…" : "Enter workspace"}</span>
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </button>
        </form>

        <div className="mt-5">
          <PasskeyLoginButton pwa={isPwa} />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-500">
        <LockKeyhole className="size-3.5" />
        <span>Protected with encrypted, secure sessions</span>
      </div>
    </Shell>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-[13px] font-medium text-slate-300">
        {label}
      </label>
      {children}
    </div>
  );
}

function TwoFactorStep({ methods, brand }: { methods: string[]; brand: LoginBrand }) {
  const [state, formAction, pending] = useActionState<{ error?: string } | undefined, FormData>(verifySecondFactor, undefined);
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const hasTotp = methods.includes("totp");
  const hasEmail = methods.includes("email");

  return (
    <Shell brand={brand}>
      <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-orange-400/20 bg-orange-400/10 text-orange-400 shadow-[0_0_35px_rgba(249,115,22,0.12)]">
        <ShieldCheck className="size-6" />
      </div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-orange-400">Identity check</p>
      <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white">One more step.</h1>
      <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">
        {hasTotp ? "Enter the six-digit code from your authenticator app." : "Enter the code we sent to your email."}
      </p>

      <div className={`mt-8 ${state?.error ? "animate-shake" : ""}`}>
        <form action={formAction} className="space-y-4">
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
          />
          {state?.error && <p role="alert" className="text-sm text-red-300">{state.error}</p>}
          <button type="submit" className="login-submit" disabled={pending}>
            {pending ? "Verifying…" : "Verify and continue"}
            <ArrowRight className="size-4" />
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
  return (
    <main className="relative min-h-[100dvh] overflow-hidden bg-[#070909] text-white lg:grid lg:grid-cols-[minmax(430px,0.82fr)_1.18fr]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(249,115,22,0.11),transparent_32%)] lg:hidden" />
      <section className="relative z-10 flex min-h-[100dvh] flex-col px-6 py-7 sm:px-10 lg:px-14 xl:px-20">
        <header className="flex items-center justify-between">
          {brand.logoUrl ? (
            // A tenant logo is an arbitrary uploaded image with no recorded
            // intrinsic size, streamed from our own route — next/image needs
            // dimensions we do not have. `max-h` bounds it either way.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt={brand.displayName} className="h-8 w-auto object-contain sm:h-9" />
          ) : (
            <Image src="/branding/denago-cape-town-logo.png" alt="Denago Cape Town" width={230} height={58} priority className="h-8 w-auto object-contain sm:h-9" />
          )}
          <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Secure access</span>
        </header>
        <div className="my-auto w-full max-w-[420px] self-center py-14">{children}</div>
        <footer className="flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-slate-700">
          <span>{brand.branded ? brand.displayName : "Denago Cape Town"}</span>
          <span>v{APP_VERSION}</span>
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
      className="relative hidden overflow-hidden border-l border-white/[0.06] bg-[#0c0f0e] lg:block"
    >
      <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] [background-size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]" />
      <div className="absolute -right-28 -top-28 size-[500px] rounded-full border border-orange-500/10" />
      <div className="absolute -right-12 -top-12 size-[330px] rounded-full border border-orange-500/10" />
      <motion.div style={{ x: glowX, y: glowY }} className="absolute right-[8%] top-[12%] size-80 rounded-full bg-orange-600/20 blur-[110px]" />

      <div className="relative flex h-full min-h-[680px] flex-col justify-between p-12 xl:p-16">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" /><span className="relative size-2 rounded-full bg-emerald-400" /></span>
            Operations online
          </div>
          <Zap className="size-5 text-orange-500" fill="currentColor" />
        </div>

        <div className="relative mx-auto w-full max-w-3xl py-14">
          <motion.div style={{ x: cardX, y: cardY }} className="relative rounded-[32px] border border-white/10 bg-white/[0.055] p-7 shadow-[0_40px_120px_rgba(0,0,0,.5)] backdrop-blur-xl xl:p-9">
            <div className="mb-10 flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Today’s pulse</p>
                <p className="mt-2 text-2xl font-medium tracking-tight">{brand.branded ? brand.displayName : "Cape Town hub"}</p>
              </div>
              {brand.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt="" className="h-12 w-auto object-contain drop-shadow-[0_12px_25px_rgba(249,115,22,.28)]" />
              ) : (
                <Image src="/branding/denago-mark.png" alt="" width={68} height={68} className="h-12 w-auto drop-shadow-[0_12px_25px_rgba(249,115,22,.28)]" />
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Metric value="14" label="Active leads" accent />
              <Metric value="6" label="In workshop" />
              <Metric value="3" label="Deliveries" />
            </div>
            <div className="mt-7 rounded-2xl border border-white/[0.06] bg-black/20 p-4">
              <div className="mb-5 flex items-center justify-between text-xs"><span className="text-slate-400">Team momentum</span><span className="text-emerald-400">+18% this week</span></div>
              <div className="flex h-20 items-end gap-2">
                {[38, 52, 44, 68, 58, 82, 72, 96, 84, 100].map((height, index) => <div key={height + index} className={`flex-1 rounded-t-sm ${index === 9 ? "bg-orange-500" : "bg-white/10"}`} style={{ height: `${height}%` }} />)}
              </div>
            </div>
            <div className="absolute -bottom-5 -right-5 flex items-center gap-3 rounded-2xl border border-white/10 bg-[#171a18]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
              <span className="flex size-8 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400"><Check className="size-4" /></span>
              <div><p className="text-xs font-medium">Follow-up complete</p><p className="mt-0.5 text-[10px] text-slate-500">Customer journey updated</p></div>
            </div>
          </motion.div>
        </div>

        <div>
          <p className="max-w-xl text-3xl font-medium leading-tight tracking-[-0.035em] text-white xl:text-4xl">Every lead. Every vehicle.<br /><span className="text-slate-500">One electric rhythm.</span></p>
          <p className="mt-4 max-w-md text-sm leading-6 text-slate-500">{brand.branded ? (brand.tagline ?? `The command centre for ${brand.displayName} sales, service and lasting customer relationships.`) : "The command centre for Denago sales, service and lasting customer relationships."}</p>
        </div>
      </div>
    </section>
  );
}

function Metric({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return <div className={`rounded-2xl border p-4 ${accent ? "border-orange-400/20 bg-orange-400/10" : "border-white/[0.06] bg-white/[0.025]"}`}><p className={`text-2xl font-semibold ${accent ? "text-orange-400" : "text-white"}`}>{value}</p><p className="mt-1 text-[11px] text-slate-500">{label}</p></div>;
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
