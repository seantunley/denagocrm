"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, KeyRound, LogOut, Settings, Trash2, UserRound } from "lucide-react";
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
 * `compact` now means only "opens downward" — a bar at the top of the page cannot
 * open a panel upwards. It used to also select an avatar-only trigger, but that
 * left the signed-in name invisible on the one surface everybody looks at, so
 * there is a single trigger and the name column simply drops below `sm`.
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
    <Avatar className="size-7 rounded-full">
      {user.avatarVersion ? (
        <AvatarImage
          src={`/api/profile/avatar?v=${encodeURIComponent(user.avatarVersion)}`}
          alt=""
          className="rounded-full object-cover"
        />
      ) : null}
      <AvatarFallback className="rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {initials(user.name)}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* ONE trigger. The name column is hidden below `sm` rather than being a
            second variant: this renders in both the mobile header and the desktop
            top bar, and a full name plus role does not fit next to the burger and
            search on a phone. The dropdown still carries the name for that case. */}
        <button
          type="button"
          aria-label={`Account — ${user.name}`}
          className="flex items-center gap-2 rounded-lg p-0.5 text-left transition-colors hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent sm:pr-1.5"
        >
          {avatar}
          <span className="hidden min-w-0 sm:block">
            <span className="block truncate text-[13px] font-medium leading-tight text-sidebar-foreground">
              {user.name}
            </span>
            <span className="block truncate text-[11px] capitalize leading-tight text-muted-foreground">
              {user.role}
            </span>
          </span>
          <ChevronDown className="hidden size-3.5 shrink-0 text-muted-foreground sm:block" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={compact ? "bottom" : "top"}
        sideOffset={compact ? 8 : 4}
        collisionPadding={16}
        className="w-[13.5rem]"
      >
        {/* Who you are signed in as — now the fallback for phones, where the
            trigger's name column is hidden and the avatar stands alone. */}
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
