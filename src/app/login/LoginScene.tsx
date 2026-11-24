"use client";

import { useRef } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue } from "framer-motion";
import { Check, Zap } from "lucide-react";
import type { LoginBrand } from "@/lib/loginBrand";
import { loginSubheading, type LoginLook } from "@/lib/loginLook";
import { cn } from "@/lib/utils";

/**
 * The sign-in screen's customisable parts (lib/loginLook.ts), shared by the real page (LoginClient) and the editor's
 * live preview (components/branding/LoginLookEditor), so what an owner previews is what ships.
 */
export type SceneBrand = Pick<LoginBrand, "displayName" | "tagline" | "logoUrl" | "look" | "backgroundUrl" | "cardImageUrl">;

/** "Staff portal / Welcome back. / Sign in to …" above the form. */
export function SignInIntro({ brand }: { brand: SceneBrand }) {
  const { look } = brand;
  const sub = loginSubheading(look, brand.displayName);
  return (
    <div className="mb-6 sm:mb-8 short:mb-4">
      {look.eyebrow && <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-primary short:hidden">{look.eyebrow}</p>}
      <h1 className="text-3xl font-semibold tracking-[-0.04em] text-white sm:text-4xl short:text-2xl">{look.heading}</h1>
      {sub && <p className="mt-2 text-sm leading-6 text-slate-400 short:hidden">{sub}</p>}
    </div>
  );
}

/**
 * The right-hand side: the standard backdrop or the workspace's own photo, the status line, the card spot (the
 * dashboard card, the workspace's own picture, or nothing) and the headline. Pure decoration: the figures are
 * illustrative and never real data — the page is public.
 */
export function BrandScene({ brand, preview = false }: { brand: SceneBrand; preview?: boolean }) {
  const { look } = brand;
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
  const photo = brand.backgroundUrl;

  return (
    <section
      ref={ref}
      onMouseMove={(event) => {
        if (reduced || preview || !ref.current) return;
        const bounds = ref.current.getBoundingClientRect();
        mouseX.set((event.clientX - bounds.left) / bounds.width);
        mouseY.set((event.clientY - bounds.top) / bounds.height);
      }}
      aria-hidden="true"
      className={cn("relative overflow-hidden border-l border-white/[0.06] bg-[#0c0f0e]", preview ? "block h-full" : "hidden lg:block")}
    >
      {photo ? (
        <>
          {/* The workspace's own photo, darkened at the foot so the headline stays readable over any picture. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- an uploaded picture with no recorded size, from our own route */}
          <img src={photo} alt="" className="absolute inset-0 size-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/20" />
        </>
      ) : (
        <>
          <div className="absolute inset-0 opacity-35 [background-image:linear-gradient(rgba(255,255,255,.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.035)_1px,transparent_1px)] [background-size:72px_72px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]" />
          <div className="absolute -right-28 -top-28 size-[500px] rounded-full border border-primary/10" />
          <div className="absolute -right-12 -top-12 size-[330px] rounded-full border border-primary/10" />
          <motion.div style={{ x: glowX, y: glowY }} className="absolute right-[8%] top-[12%] size-80 rounded-full bg-primary/20 blur-[110px]" />
        </>
      )}

      <div className={cn("relative flex h-full flex-col justify-between p-12 xl:p-16", !preview && "min-h-[680px]")}>
        <div className="flex min-h-5 items-center justify-between">
          {look.status ? (
            <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
              <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" /><span className="relative size-2 rounded-full bg-emerald-400" /></span>
              {look.status}
            </div>
          ) : <span />}
          {!photo && <Zap className="size-5 text-primary" fill="currentColor" />}
        </div>

        <div className="relative mx-auto w-full max-w-3xl py-14">
          {look.card === "dashboard" && <DashboardCard brand={brand} x={cardX} y={cardY} />}
          {look.card === "image" && brand.cardImageUrl && (
            <motion.div style={{ x: cardX, y: cardY }} className="overflow-hidden rounded-[32px] border border-white/10 shadow-[0_40px_120px_rgba(0,0,0,.5)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- an uploaded picture with no recorded size, from our own route */}
              <img src={brand.cardImageUrl} alt="" className="max-h-[440px] w-full object-cover" />
            </motion.div>
          )}
        </div>

        <div>
          {(look.headline || look.headlineSoft) && (
            <p className="max-w-xl text-3xl font-medium leading-tight tracking-[-0.035em] text-white xl:text-4xl">
              {look.headline}
              {look.headline && look.headlineSoft && <br />}
              {look.headlineSoft && <span className={photo ? "text-slate-300" : "text-slate-500"}>{look.headlineSoft}</span>}
            </p>
          )}
          <p className={cn("mt-4 max-w-md text-sm leading-6", photo ? "text-slate-300" : "text-slate-500")}>
            {look.subline || brand.tagline || `The command centre for ${brand.displayName}: leads, customers and the follow-ups that keep them.`}
          </p>
        </div>
      </div>
    </section>
  );
}

type Motion = MotionValue<number>;

function DashboardCard({ brand, x, y }: { brand: SceneBrand; x: Motion; y: Motion }) {
  const { look } = brand;
  return (
    <motion.div style={{ x, y }} className="relative rounded-[32px] border border-white/10 bg-white/[0.055] p-7 shadow-[0_40px_120px_rgba(0,0,0,.5)] backdrop-blur-xl xl:p-9">
      <div className="mb-10 flex items-start justify-between">
        <div>
          {look.cardEyebrow && <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{look.cardEyebrow}</p>}
          <p className="mt-2 text-2xl font-medium tracking-tight">{brand.displayName}</p>
        </div>
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoUrl} alt="" className="h-12 w-auto object-contain drop-shadow-[0_12px_25px_color-mix(in_oklab,var(--primary)_28%,transparent)]" />
        ) : null}
      </div>
      <Tiles look={look} />
      <div className="mt-7 rounded-2xl border border-white/[0.06] bg-black/20 p-4">
        <div className="mb-5 flex min-h-4 items-center justify-between text-xs">
          <span className="text-slate-400">{look.chartLabel}</span>
          {look.chartNote && <span className="text-emerald-400">{look.chartNote}</span>}
        </div>
        <div className="flex h-20 items-end gap-2">
          {[38, 52, 44, 68, 58, 82, 72, 96, 84, 100].map((height, index) => <div key={height + index} className={`flex-1 rounded-t-sm ${index === 9 ? "bg-primary" : "bg-white/10"}`} style={{ height: `${height}%` }} />)}
        </div>
      </div>
      {look.toastTitle && (
        <div className="absolute -bottom-5 -right-5 flex items-center gap-3 rounded-2xl border border-white/10 bg-[#171a18]/95 px-4 py-3 shadow-2xl backdrop-blur-xl">
          <span className="flex size-8 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400"><Check className="size-4" /></span>
          <div><p className="text-xs font-medium">{look.toastTitle}</p>{look.toastText && <p className="mt-0.5 text-[10px] text-slate-500">{look.toastText}</p>}</div>
        </div>
      )}
    </motion.div>
  );
}

const FIGURES = ["14", "6", "3"];

function Tiles({ look }: { look: LoginLook }) {
  const tiles = look.cardTiles.map((label, i) => ({ label, value: FIGURES[i] })).filter((tile) => tile.label);
  if (!tiles.length) return null;
  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map((tile, i) => <Metric key={i} value={look.cardNumbers ? tile.value : null} label={tile.label} accent={i === 0} />)}
    </div>
  );
}

/**
 * Tablet portrait (md up to lg): the card folded down to its tiles, where the full panel has no room. Only when the
 * workspace shows the dashboard card.
 */
export function PulseStrip({ look }: { look: LoginLook }) {
  if (look.card !== "dashboard") return null;
  return (
    <div aria-hidden="true" className="mt-10 hidden md:block lg:hidden">
      {look.cardEyebrow && <p className="mb-3 text-[10px] uppercase tracking-[0.22em] text-slate-600">{look.cardEyebrow}</p>}
      <Tiles look={look} />
    </div>
  );
}

function Metric({ value, label, accent = false }: { value: string | null; label: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? "border-primary/20 bg-primary/10" : "border-white/[0.06] bg-white/[0.025]"}`}>
      {value !== null && <p className={`text-2xl font-semibold ${accent ? "text-primary" : "text-white"}`}>{value}</p>}
      <p className={cn("text-[11px]", value !== null ? "mt-1 text-slate-500" : accent ? "text-primary" : "text-slate-300")}>{label}</p>
    </div>
  );
}
