"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import {
  ArrowRight,
  CalendarCheck,
  Check,
  FileText,
  Headphones,
  KeyRound,
  LockKeyhole,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { requestPortalOtp, verifyPortalOtp } from "@/app/actions/portal";

const PORTAL_FEATURES = [
  {
    icon: CalendarCheck,
    title: "Service, simplified",
    copy: "See service history and request your next visit.",
  },
  {
    icon: FileText,
    title: "Everything on file",
    copy: "Quotes and important vehicle documents in one place.",
  },
  {
    icon: Headphones,
    title: "Support that knows you",
    copy: "Start a conversation without repeating your story.",
  },
];

import type { LoginBrand } from "@/lib/loginBrand";

/**
 * Every brand substitution is gated on `brand.branded`, and the false branch is
 * the ORIGINAL literal — so an unbranded portal login is byte-for-byte what it
 * was before branding existed. See tests/loginBranding.test.ts.
 */
export default function PortalLoginClient({ brand }: { brand: LoginBrand }) {
  const [email, setEmail] = useState("");
  const [editingEmail, setEditingEmail] = useState(false);
  const [reqState, requestAction, reqPending] = useActionState(requestPortalOtp, undefined);
  const [verState, verifyAction, verPending] = useActionState(verifyPortalOtp, undefined);
  const sent = Boolean(reqState?.sent) && !editingEmail;

  return (
    <div className="portal-login-page relative min-h-[100dvh] overflow-x-hidden bg-[#070908] text-white lg:grid lg:grid-cols-[1.08fr_minmax(460px,0.92fr)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_0%,rgba(249,115,22,0.14),transparent_30%)] lg:hidden" />

      <CustomerStory brand={brand} />

      <section className="relative z-10 flex min-h-[100dvh] flex-col border-white/[0.07] px-5 py-6 sm:px-10 sm:py-8 lg:border-l lg:bg-[#0a0d0c]/95 lg:px-14 xl:px-20">
        <header className="flex items-center justify-between gap-4">
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.logoUrl} alt={brand.displayName} className="h-8 w-auto object-contain sm:h-9" />
          ) : (
            <Image
              src="/branding/denago-cape-town-logo.png"
              alt="Denago Cape Town"
              width={230}
              height={58}
              preload
              className="h-8 w-auto object-contain sm:h-9"
            />
          )}
          <span className="rounded-full border border-white/[0.09] bg-white/[0.035] px-3 py-1.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500 sm:text-[10px]">
            Customer portal
          </span>
        </header>

        <div className="my-auto w-full max-w-[440px] self-center py-12 sm:py-16">
          <div className="mb-8">
            <div className="mb-5 flex size-11 items-center justify-center rounded-2xl border border-orange-400/20 bg-orange-400/10 text-orange-400 shadow-[0_0_40px_rgba(249,115,22,0.12)]">
              {sent ? <Mail className="size-5" /> : <Sparkles className="size-5" />}
            </div>
            <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.24em] text-orange-400">
              {`Your ${brand.displayName}`}
            </p>
            <h1 className="max-w-md text-3xl font-semibold leading-[1.08] tracking-[-0.045em] text-white sm:text-[2.5rem]">
              {sent ? "Your secure code is on its way." : "Your ownership journey, connected."}
            </h1>
            <p className="mt-3 max-w-sm text-sm leading-6 text-slate-400">
              {sent
                ? "Enter the six-digit code from your email to open your portal."
                : "Access your vehicles, documents and support with the email already linked to your customer profile."}
            </p>
          </div>

          <StepIndicator sent={sent} />

          <div className={sent ? "portal-form-in" : undefined}>
            {!sent ? (
              <form
                action={requestAction}
                onSubmit={() => setEditingEmail(false)}
                className={`space-y-5 ${reqState?.error ? "animate-shake" : ""}`}
              >
                <div>
                  <label className="mb-2 block text-[13px] font-medium text-slate-300" htmlFor="portal-email">
                    Email linked to your profile
                  </label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-slate-500" />
                    <input
                      id="portal-email"
                      name="email"
                      type="email"
                      required
                      autoFocus
                      autoComplete="email"
                      className="login-input h-13 pl-12"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@email.com"
                    />
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-slate-600">
                    {`Use the address you shared with ${brand.displayName}.`}
                  </p>
                </div>

                {reqState?.error && (
                  <p role="alert" className="rounded-xl border border-red-400/15 bg-red-400/8 px-3 py-2.5 text-sm text-red-300">
                    {reqState.error}
                  </p>
                )}

                <button type="submit" className="login-submit group" disabled={reqPending}>
                  <span>{reqPending ? "Sending your code…" : "Continue securely"}</span>
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                </button>
              </form>
            ) : (
              <div className={verState?.error ? "animate-shake" : undefined}>
                <div className="mb-5 flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-400">
                    <Check className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-slate-600">Sent to</p>
                    <p className="truncate text-sm font-medium text-slate-200">{email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingEmail(true)}
                    className="text-xs font-medium text-slate-500 transition hover:text-white"
                  >
                    Change
                  </button>
                </div>

                <form action={verifyAction} className="space-y-5">
                  <input type="hidden" name="email" value={email} />
                  <div>
                    <label className="mb-2 block text-[13px] font-medium text-slate-300" htmlFor="portal-code">
                      Six-digit verification code
                    </label>
                    <div className="relative">
                      <KeyRound className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-slate-500" />
                      <input
                        id="portal-code"
                        name="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        required
                        autoFocus
                        className="login-input h-14 pl-12 text-center font-mono text-xl tracking-[0.42em]"
                        placeholder="000000"
                      />
                    </div>
                  </div>

                  {verState?.error && (
                    <p role="alert" className="rounded-xl border border-red-400/15 bg-red-400/8 px-3 py-2.5 text-sm text-red-300">
                      {verState.error}
                    </p>
                  )}

                  <button type="submit" className="login-submit group" disabled={verPending}>
                    <span>{verPending ? "Opening your portal…" : "Open my portal"}</span>
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
                  </button>
                </form>

                <form action={requestAction} className="mt-3 text-center">
                  <input type="hidden" name="email" value={email} />
                  <button
                    type="submit"
                    disabled={reqPending}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-slate-600 transition hover:text-slate-300 disabled:cursor-wait"
                  >
                    <RefreshCw className={`size-3.5 ${reqPending ? "animate-spin" : ""}`} />
                    {reqPending ? "Sending again…" : "Send another code"}
                  </button>
                </form>
              </div>
            )}
          </div>

          <div className="mt-7 flex items-start gap-2.5 border-t border-white/[0.06] pt-5 text-[11px] leading-5 text-slate-600">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" />
            <span>No password to remember. Your one-time code expires after ten minutes.</span>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 text-[10px] uppercase tracking-[0.14em] text-slate-700">
          <span>{brand.displayName}</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3" />Private &amp; secure</span>
        </footer>
      </section>
    </div>
  );
}
function StepIndicator({ sent }: { sent: boolean }) {
  return (
    <div className="mb-7 flex items-center gap-3" aria-label={sent ? "Step 2 of 2" : "Step 1 of 2"}>
      <span className={`flex size-6 items-center justify-center rounded-full text-[10px] font-bold ${sent ? "bg-emerald-400 text-[#07110b]" : "bg-orange-500 text-white"}`}>
        {sent ? <Check className="size-3.5" /> : "1"}
      </span>
      <span className={`text-xs font-medium ${sent ? "text-slate-500" : "text-slate-200"}`}>Your email</span>
      <span className="h-px flex-1 bg-white/[0.08]" />
      <span className={`flex size-6 items-center justify-center rounded-full text-[10px] font-bold ${sent ? "bg-orange-500 text-white" : "border border-white/10 bg-white/[0.035] text-slate-600"}`}>2</span>
      <span className={`text-xs font-medium ${sent ? "text-slate-200" : "text-slate-600"}`}>Verify</span>
    </div>
  );
}

function CustomerStory({ brand }: { brand: LoginBrand }) {
  return (
    <section className="relative hidden min-h-[100dvh] flex-col justify-between overflow-hidden bg-[#0b0e0d] p-12 lg:flex xl:p-16">
      <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.03)_1px,transparent_1px)] [background-size:76px_76px] [mask-image:linear-gradient(to_bottom,black,transparent_92%)]" />
      <div className="absolute -left-48 -top-48 size-[560px] rounded-full border border-orange-500/10" />
      <div className="absolute -left-28 -top-28 size-[360px] rounded-full border border-orange-500/10" />
      <div className="absolute left-[15%] top-[12%] size-80 rounded-full bg-orange-600/15 blur-[110px]" />

      <div className="relative flex items-center gap-2 text-xs font-medium text-slate-500">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-40" />
          <span className="relative size-2 rounded-full bg-emerald-400" />
        </span>
        Connected ownership
      </div>

      <div className="relative mx-auto w-full max-w-3xl py-12">
        <div className="relative overflow-hidden rounded-[34px] border border-white/[0.1] bg-white/[0.055] p-7 shadow-[0_45px_140px_rgba(0,0,0,.52)] backdrop-blur-xl xl:p-9">
          <div className="absolute -right-14 -top-14 size-44 rounded-full bg-orange-500/10 blur-3xl" />
          <div className="relative mb-10 flex items-start justify-between gap-6">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-400">{`My ${brand.displayName}`}</p>
              <p className="mt-2 text-2xl font-medium tracking-[-0.035em] text-white">Everything that moves with you.</p>
            </div>
            <div className="flex size-14 items-center justify-center rounded-2xl border border-orange-400/15 bg-orange-400/10 shadow-[0_18px_45px_rgba(249,115,22,.12)]">
              {brand.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt="" className="h-9 w-auto object-contain" />
              ) : (
                <Image src="/branding/denago-mark.png" alt="" width={68} height={68} className="h-9 w-auto object-contain" />
              )}
            </div>
          </div>

          <div className="relative grid gap-3 xl:grid-cols-3">
            {PORTAL_FEATURES.map((feature, index) => (
              <div key={feature.title} className={`rounded-2xl border p-4 ${index === 0 ? "border-orange-400/20 bg-orange-400/[0.09]" : "border-white/[0.07] bg-black/15"}`}>
                <feature.icon className={`size-5 ${index === 0 ? "text-orange-400" : "text-slate-500"}`} />
                <p className="mt-7 text-sm font-medium text-slate-100">{feature.title}</p>
                <p className="mt-1.5 text-[11px] leading-5 text-slate-500">{feature.copy}</p>
              </div>
            ))}
          </div>

          <div className="relative mt-4 flex items-center justify-between rounded-2xl border border-white/[0.06] bg-black/20 px-4 py-3.5">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400"><ShieldCheck className="size-4" /></span>
              <div><p className="text-xs font-medium text-slate-300">Secure by design</p><p className="mt-0.5 text-[10px] text-slate-600">Passwordless access, protected customer data</p></div>
            </div>
            <span className="text-[10px] uppercase tracking-[0.16em] text-slate-700">{brand.displayName}</span>
          </div>
        </div>
      </div>

      <div className="relative">
        <h2 className="max-w-2xl text-3xl font-medium leading-[1.08] tracking-[-0.04em] text-white xl:text-4xl">
          More than a vehicle.<br />
          <span className="text-slate-500">A better way to stay connected.</span>
        </h2>
        <p className="mt-4 max-w-lg text-sm leading-6 text-slate-500">
          {`Your personal window into service, documents and support from ${brand.displayName}.`}
        </p>
      </div>
    </section>
  );
}
