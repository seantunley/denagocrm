"use client";

import { useActionState, useEffect, useState } from "react";
import { CheckCircle2, ImagePlus, Mail, Trash2, UserRound } from "lucide-react";
import {
  removeOwnAvatar,
  updateOwnAvatar,
  updateOwnEmail,
  updateOwnProfile,
  type FormState,
} from "@/app/actions/settings";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const initialState: FormState = {};

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function Result({ state }: { state: FormState }) {
  if (!state.error && !state.ok) return null;
  return (
    <p
      aria-live="polite"
      className={`text-xs ${state.error ? "text-destructive" : "text-emerald-400"}`}
    >
      {state.error ?? state.ok}
    </p>
  );
}

export default function ProfileSettingsForms({
  name,
  email,
  mobile,
  jobTitle,
  role,
  createdAt,
  hasAvatar,
  avatarVersion,
}: {
  name: string;
  email: string;
  mobile: string | null;
  jobTitle: string | null;
  role: string;
  createdAt: string;
  hasAvatar: boolean;
  avatarVersion: string | null;
}) {
  const [profileState, profileAction, profilePending] = useActionState(updateOwnProfile, initialState);
  const [emailState, emailAction, emailPending] = useActionState(updateOwnEmail, initialState);
  const [photoState, photoAction, photoPending] = useActionState(updateOwnAvatar, initialState);
  const [removeState, removeAction, removePending] = useActionState(removeOwnAvatar, initialState);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const avatarSrc = preview ?? (hasAvatar ? `/api/profile/avatar?v=${encodeURIComponent(avatarVersion ?? "current")}` : undefined);

  return (
    <div className="space-y-6">
      <section className="card overflow-hidden p-0">
        <div className="border-b border-border/60 bg-gradient-to-r from-primary/10 via-transparent to-transparent p-5 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
            <Avatar className="size-24 border-2 border-background shadow-xl">
              {avatarSrc ? <AvatarImage src={avatarSrc} alt={`${name}'s profile photo`} className="object-cover" /> : null}
              <AvatarFallback className="bg-primary/15 text-2xl font-semibold text-primary">{initials(name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-xl font-semibold tracking-tight">{name}</h2>
                <span className="badge bg-primary/15 capitalize text-primary">{role}</span>
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">{email}</p>
              <p className="mt-2 text-xs text-muted-foreground">Member since {createdAt}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-6">
          <form action={photoAction} className="space-y-3">
            <div>
              <label htmlFor="profile-avatar" className="label">Profile photo</label>
              <p className="mb-3 text-xs text-muted-foreground">JPG, PNG or WebP. Maximum 3 MB. Square images work best.</p>
              <input
                id="profile-avatar"
                name="avatar"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="input h-auto cursor-pointer py-2 file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  setPreview((previous) => {
                    if (previous) URL.revokeObjectURL(previous);
                    return file ? URL.createObjectURL(file) : null;
                  });
                }}
                required
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn-primary btn-sm" disabled={photoPending}>
                <ImagePlus className="size-4" /> {photoPending ? "Uploading…" : "Upload photo"}
              </button>
              <Result state={photoState} />
            </div>
          </form>
          {hasAvatar ? (
            <form action={removeAction}>
              <button className="btn-secondary btn-sm text-destructive" disabled={removePending}>
                <Trash2 className="size-4" /> {removePending ? "Removing…" : "Remove photo"}
              </button>
              <Result state={removeState} />
            </form>
          ) : null}
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <div className="mb-5 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><UserRound className="size-4" /></span>
          <div><h2 className="font-semibold">Personal details</h2><p className="text-xs text-muted-foreground">Used across assignments, communications and your email signature.</p></div>
        </div>
        <form action={profileAction} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-name" className="label">Full name</label>
            <input id="profile-name" name="name" className="input" defaultValue={name} maxLength={100} autoComplete="name" required />
          </div>
          <div>
            <label htmlFor="profile-job-title" className="label">Job title <span className="font-normal text-muted-foreground">(optional)</span></label>
            <input id="profile-job-title" name="jobTitle" className="input" defaultValue={jobTitle ?? ""} maxLength={100} autoComplete="organization-title" placeholder="e.g. Sales Consultant" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="profile-mobile" className="label">Phone number <span className="font-normal text-muted-foreground">(optional)</span></label>
            <input id="profile-mobile" name="mobile" type="tel" className="input" defaultValue={mobile ?? ""} maxLength={30} autoComplete="tel" placeholder="e.g. +27 82 123 4567" />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button className="btn-primary btn-sm" disabled={profilePending}>{profilePending ? "Saving…" : "Save profile"}</button>
            <Result state={profileState} />
          </div>
        </form>
      </section>

      <section className="card p-5 sm:p-6">
        <div className="mb-5 flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Mail className="size-4" /></span>
          <div><h2 className="font-semibold">Sign-in email</h2><p className="text-xs text-muted-foreground">Changing this also changes the email you use to sign in.</p></div>
        </div>
        <form action={emailAction} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-email" className="label">Email address</label>
            <input id="profile-email" name="email" type="email" className="input" defaultValue={email} maxLength={254} autoComplete="email" required />
          </div>
          <div>
            <label htmlFor="profile-current-password" className="label">Current password</label>
            <input id="profile-current-password" name="currentPassword" type="password" className="input" autoComplete="current-password" required />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button className="btn-primary btn-sm" disabled={emailPending}>{emailPending ? "Updating…" : "Update email"}</button>
            <Result state={emailState} />
          </div>
        </form>
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> For security, changing your email signs out your other devices.
        </div>
      </section>
    </div>
  );
}
