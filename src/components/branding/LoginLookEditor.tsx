"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, ImageUp, RotateCcw } from "lucide-react";
import { SaveButton, SaveForm } from "@/components/SaveForm";
import BrandLogo from "@/components/BrandLogo";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { BrandScene, SignInIntro, type SceneBrand } from "@/app/login/LoginScene";
import { LOGIN_DEFAULTS, LOGIN_TEXT_FIELDS, LOGIN_TILE_MAX, loginImageUrl, type LoginLook } from "@/lib/loginLook";
import type { ActionResult } from "@/lib/actionResultTypes";

type MaybeActionResult = ActionResult | void | undefined;
import { cn } from "@/lib/utils";

/**
 * The sign-in screen editor (lib/loginLook.ts), with a live preview drawn by the SAME components the sign-in page uses
 * (app/login/LoginScene.tsx) — what you see here is what staff see. Used by the workspace owner (Settings → Company
 * profile) and a platform admin (console), each with their own save action.
 */
export default function LoginLookEditor({
  action,
  resetAction,
  initial,
  tenantId,
  displayName,
  tagline,
  logoUrl,
  accent,
}: {
  action: (formData: FormData) => Promise<MaybeActionResult>;
  resetAction?: () => Promise<MaybeActionResult>;
  initial: LoginLook;
  tenantId: string;
  displayName: string;
  tagline: string | null;
  logoUrl: string | null;
  /** The workspace's accent colour, for the preview where the page around it is another workspace's (the console). */
  accent?: { primary: string; foreground: string } | null;
}) {
  const [look, setLook] = useState<LoginLook>(initial);
  const [picked, setPicked] = useState<{ bg: string | null; card: string | null }>({ bg: null, card: null });
  const set = <K extends keyof LoginLook>(key: K, value: LoginLook[K]) => setLook((current) => ({ ...current, [key]: value }));

  // A chosen file previews straight away; the object URL is released when replaced or on leaving.
  useEffect(() => () => { if (picked.bg) URL.revokeObjectURL(picked.bg); }, [picked.bg]);
  useEffect(() => () => { if (picked.card) URL.revokeObjectURL(picked.card); }, [picked.card]);

  const backgroundUrl = look.background === "image" ? picked.bg ?? loginImageUrl(tenantId, look.backgroundImage) : null;
  const cardImageUrl = look.card === "image" ? picked.card ?? loginImageUrl(tenantId, look.cardImage) : null;
  const scene: SceneBrand = { displayName, tagline, logoUrl, look, backgroundUrl, cardImageUrl };

  const text = (field: keyof typeof LOGIN_TEXT_FIELDS, label: string, hint?: string) => (
    <label className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        name={field}
        value={look[field]}
        maxLength={LOGIN_TEXT_FIELDS[field].max}
        placeholder={LOGIN_TEXT_FIELDS[field].blank === "hide" ? "Leave blank to hide" : LOGIN_DEFAULTS[field]}
        onChange={(event) => set(field, event.target.value)}
        className="input"
      />
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <SaveForm action={action} success="Sign-in screen saved" resetOnSuccess={false} className="space-y-5">
        <Group title="Above the sign-in form">
          {text("eyebrow", "Small label")}
          {text("heading", "Heading")}
          {text("subheading", "Line under the heading", "{name} is replaced with your business name.")}
          {text("buttonLabel", "Sign-in button")}
          {text("badge", "Top-right label")}
        </Group>

        <Group title="Right-hand side — background">
          <Choice name="background" value={look.background} onChange={(v) => set("background", v as LoginLook["background"])} options={[["standard", "Standard"], ["image", "Your own photo"]]} />
          {look.background === "image" && (
            <PictureField
              name="backgroundImage"
              removeName="removeBackgroundImage"
              hasSaved={Boolean(look.backgroundImage)}
              hint="A wide photo works best, at least 1600 pixels across. PNG, JPEG or WebP, under 4 MB. The bottom is darkened so the headline stays readable."
              onPick={(url) => setPicked((p) => ({ ...p, bg: url }))}
            />
          )}
          {text("status", "Status line at the top")}
        </Group>

        <Group title="Right-hand side — the card">
          <Choice name="card" value={look.card} onChange={(v) => set("card", v as LoginLook["card"])} options={[["dashboard", "Sample dashboard"], ["image", "Your own picture"], ["none", "Nothing"]]} />
          {look.card === "dashboard" && (
            <>
              {text("cardEyebrow", "Card title")}
              <div className="grid grid-cols-3 gap-2">
                {[0, 1, 2].map((i) => (
                  <label key={i} className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Tile {i + 1}</span>
                    <input
                      name={`cardTile${i}`}
                      value={look.cardTiles[i]}
                      maxLength={LOGIN_TILE_MAX}
                      placeholder="Blank hides"
                      onChange={(event) => set("cardTiles", look.cardTiles.map((t, j) => (j === i ? event.target.value : t)) as LoginLook["cardTiles"])}
                      className="input"
                    />
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="cardNumbers" checked={look.cardNumbers} onChange={(event) => set("cardNumbers", event.target.checked)} className="size-4" />
                Show sample numbers on the tiles
              </label>
              {text("chartLabel", "Chart caption")}
              {text("chartNote", "Chart note")}
              {text("toastTitle", "Pop-up note")}
              {text("toastText", "Pop-up note, second line")}
            </>
          )}
          {look.card === "image" && (
            <PictureField
              name="cardImage"
              removeName="removeCardImage"
              hasSaved={Boolean(look.cardImage)}
              hint="Shown with rounded corners in the card's place. PNG, JPEG or WebP, under 4 MB."
              onPick={(url) => setPicked((p) => ({ ...p, card: url }))}
            />
          )}
          {/* The dashboard's fields are sent whatever is chosen, so switching back keeps their wording. */}
          {look.card !== "dashboard" && (
            <>
              {(["cardEyebrow", "chartLabel", "chartNote", "toastTitle", "toastText"] as const).map((f) => <input key={f} type="hidden" name={f} value={look[f]} />)}
              {look.cardTiles.map((t, i) => <input key={i} type="hidden" name={`cardTile${i}`} value={t} />)}
              {look.cardNumbers && <input type="hidden" name="cardNumbers" value="on" />}
            </>
          )}
        </Group>

        <Group title="Headline at the bottom">
          {text("headline", "First line")}
          {text("headlineSoft", "Second line (lighter)")}
          <label className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Line under the headline</span>
            <input
              name="subline"
              value={look.subline}
              maxLength={LOGIN_TEXT_FIELDS.subline.max}
              placeholder={tagline ?? "Leave blank for the standard line"}
              onChange={(event) => set("subline", event.target.value)}
              className="input"
            />
            <span className="block text-[11px] text-muted-foreground">Leave blank to use your tagline.</span>
          </label>
        </Group>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
          {resetAction ? (
            <ResetButton action={resetAction} onReset={() => setLook(LOGIN_DEFAULTS)} />
          ) : <span />}
          <SaveButton>Save sign-in screen</SaveButton>
        </div>
      </SaveForm>

      <div className="space-y-2 xl:sticky xl:top-4 xl:self-start">
        <p className="text-xs font-medium text-muted-foreground">Preview — how staff see it on a computer</p>
        <Preview scene={scene} accent={accent ?? null} />
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-border bg-card p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Choice({ name, value, onChange, options }: { name: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {options.map(([key, label]) => (
        <label key={key} className={cn("cursor-pointer rounded-lg border px-3 py-1.5 text-sm", value === key ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
          <input type="radio" name={name} value={key} checked={value === key} onChange={() => onChange(key)} className="sr-only" />
          {label}
        </label>
      ))}
    </div>
  );
}

function PictureField({ name, removeName, hasSaved, hint, onPick }: { name: string; removeName: string; hasSaved: boolean; hint: string; onPick: (url: string | null) => void }) {
  return (
    <div className="space-y-1.5">
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm hover:border-primary">
        <ImageUp className="size-4" aria-hidden />
        {hasSaved ? "Replace the picture" : "Choose a picture"}
        <input
          type="file"
          name={name}
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            onPick(file ? URL.createObjectURL(file) : null);
          }}
        />
      </label>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      {hasSaved && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" name={removeName} className="size-3.5" /> Remove the saved picture
        </label>
      )}
    </div>
  );
}

function ResetButton({ action, onReset }: { action: () => Promise<MaybeActionResult>; onReset: () => void }) {
  return (
    <ConfirmActionDialog
      destructive
      title="Put the standard sign-in screen back?"
      description="Your wording and pictures here are cleared, and your team sees the standard sign-in screen again."
      confirmLabel="Back to standard"
      onConfirm={async () => {
        const result = await action();
        if (!result || !result.error) onReset();
        return result ?? undefined;
      }}
      trigger={
        <button type="button" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-3.5" /> Back to the standard screen
        </button>
      }
    />
  );
}

/** The real sign-in layout at 1440×900, scaled to fit. */
function Preview({ scene, accent }: { scene: SceneBrand; accent: { primary: string; foreground: string } | null }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setScale(entry.contentRect.width / 1440));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const style = accent ? ({ "--primary": accent.primary, "--primary-foreground": accent.foreground } as CSSProperties) : undefined;
  return (
    <div ref={frame} className="relative w-full overflow-hidden rounded-xl border border-border" style={{ aspectRatio: "1440 / 900" }} aria-hidden>
      <div className="pointer-events-none absolute left-0 top-0 grid h-[900px] w-[1440px] origin-top-left grid-cols-[minmax(430px,0.82fr)_1.18fr] bg-[#070909] text-white" style={{ ...style, transform: `scale(${scale})` }}>
        <div className="flex flex-col px-20 py-7">
          <div className="flex items-center justify-between">
            <BrandLogo logoUrl={scene.logoUrl} alt={scene.displayName} className="h-9 w-auto object-contain" wordmarkClassName="text-base text-white" />
            {scene.look.badge && <span className="rounded-full border border-white/8 bg-white/[0.035] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{scene.look.badge}</span>}
          </div>
          <div className="my-auto w-full max-w-[420px] self-center">
            <SignInIntro brand={scene} />
            <div className="space-y-4">
              <div className="h-12 rounded-xl border border-white/10 bg-white/[0.03]" />
              <div className="h-12 rounded-xl border border-white/10 bg-white/[0.03]" />
              <div className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
                {scene.look.buttonLabel} <ArrowRight className="size-4" />
              </div>
            </div>
          </div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-slate-700">{scene.displayName}</p>
        </div>
        <BrandScene brand={scene} preview />
      </div>
    </div>
  );
}
