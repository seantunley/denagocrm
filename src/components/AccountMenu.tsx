"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronsUpDown, KeyRound, LogOut, Settings, Trash2, UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/app/login/actions";
import { APP_VERSION } from "@/lib/version";
import { cn } from "@/lib/utils";
import { clearChecklistDeviceData, offlinePendingCount } from "@/lib/checklists/deviceStore";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

export type AccountMenuUser = {
  id: string;
  name: string;
  role: string;
  avatarVersion?: string | null;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The signed-in user's menu.
 *
 * Extracted from the sidebar footer so the top bar and the mobile header can use
 * ONE implementation. Two copies of a menu containing "Sign out" is the kind of
 * thing that drifts — one gains an item and the other quietly does not.
 *
 * `compact` is the top-bar form: avatar only, no name column, and the panel opens
 * downward because a bar at the top of the page cannot open one upwards.
 */
export default function AccountMenu({
  user,
  isOwner,
  tenantId,
  compact = false,
}: {
  user: AccountMenuUser;
  isOwner: boolean;
  tenantId: string;
  compact?: boolean;
}) {
  const [discardCount, setDiscardCount] = useState(0);
  const [discardOpen, setDiscardOpen] = useState(false);

  async function signOutSafely() {
    const pending = await offlinePendingCount({ tenantId, userId: user.id });
    if (pending > 0) {
      setDiscardCount(pending);
      setDiscardOpen(true);
      return;
    }
    await clearChecklistDeviceData();
    await logout();
  }
  const avatar = (
    <Avatar className={cn("rounded-md", compact ? "size-7" : "size-7")}>
      {user.avatarVersion ? (
        <AvatarImage
          src={`/api/profile/avatar?v=${encodeURIComponent(user.avatarVersion)}`}
          alt=""
          className="rounded-md object-cover"
        />
      ) : null}
      <AvatarFallback className="rounded-md bg-primary/15 text-[11px] font-semibold text-primary">
        {initials(user.name)}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={`Account — ${user.name}`}
            className="grid place-items-center rounded-lg p-0.5 transition-colors hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent"
          >
            {avatar}
          </button>
        ) : (
          <button className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent">
            {avatar}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-sidebar-foreground">{user.name}</p>
              <p className="truncate text-[11px] capitalize text-muted-foreground">{user.role}</p>
            </div>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={compact ? "bottom" : "top"}
        sideOffset={compact ? 8 : 4}
        collisionPadding={16}
        className="w-[13.5rem]"
      >
        {/* Who you are signed in as. Obvious in the sidebar, where the name sat
            next to the avatar; not obvious behind an avatar-only trigger. */}
        {compact && (
          <>
            <DropdownMenuLabel className="pb-1">
              <span className="block truncate text-[13px] font-medium text-foreground">{user.name}</span>
              <span className="block truncate text-[11px] font-normal capitalize text-muted-foreground">{user.role}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        {/* Your own account first. These were reachable only by opening Settings
            and finding the right tab — and the password form additionally sat
            collapsed inside it, so `section=password` opens it on arrival rather
            than landing you next to it. */}
        <DropdownMenuItem asChild>
          <Link href="/settings?tab=account">
            <UserRound className="size-4" />
            My profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings?tab=account&section=password#password">
            <KeyRound className="size-4" />
            Change password
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="size-4" />
            Workspace settings
          </Link>
        </DropdownMenuItem>
        {isOwner && (
          <DropdownMenuItem asChild>
            <Link href="/trash">
              <Trash2 className="size-4" />
              Trash
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={(event) => {
            event.preventDefault();
            void signOutSafely();
          }}
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="py-1 text-[11px] font-normal text-muted-foreground">v{APP_VERSION}</DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>Discard offline work and sign out?</DialogTitle>
          <DialogDescription>
            {discardCount} offline checklist change{discardCount === 1 ? " is" : "s are"} still waiting to sync.
            Signing out will permanently discard {discardCount === 1 ? "it" : "them"} from this device.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary">Keep my work</button>
          </DialogClose>
          <button
            type="button"
            className="btn-danger"
            onClick={() => void clearChecklistDeviceData().then(() => logout())}
          >
            Discard and sign out
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
    </>
  );
}
