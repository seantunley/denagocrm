"use client";

import { Fragment, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarPlus,
  CarFront,
  Copy,
  Download,
  ExternalLink,
  FilePlus2,
  Mail,
  Pencil,
  Phone,
  Printer,
  SquareKanban,
  UserPlus,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  openQuickCreate,
  type QuickCreateDefaults,
  type QuickCreateKind,
} from "@/components/QuickCreateDialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type RecordActionIcon =
  | "calendar"
  | "car"
  | "contact"
  | "download"
  | "edit"
  | "email"
  | "jobcard"
  | "lead"
  | "phone"
  | "print"
  | "quote";

export type RecordContextAction = {
  label: string;
  href?: string;
  copyValue?: string;
  quickCreate?: QuickCreateKind;
  quickCreateDefaults?: QuickCreateDefaults;
  icon?: RecordActionIcon;
  newTab?: boolean;
  separatorBefore?: boolean;
};

const ACTION_ICONS: Record<RecordActionIcon, LucideIcon> = {
  calendar: CalendarPlus,
  car: CarFront,
  contact: UserPlus,
  download: Download,
  edit: Pencil,
  email: Mail,
  jobcard: Wrench,
  lead: SquareKanban,
  phone: Phone,
  print: Printer,
  quote: FilePlus2,
};

function isExternalHref(href: string) {
  return /^(https?:|mailto:|tel:)/.test(href);
}

export default function RecordContextMenu({
  children,
  label,
  href,
  openInNewTab = false,
  actions = [],
}: {
  children: ReactElement;
  label: string;
  href: string;
  openInNewTab?: boolean;
  actions?: RecordContextAction[];
}) {
  const router = useRouter();

  function navigate(target: string, newTab = false) {
    if (newTab) {
      window.open(target, "_blank", "noopener,noreferrer");
    } else if (isExternalHref(target)) {
      window.location.assign(target);
    } else {
      router.push(target);
    }
  }

  async function copy(value: string, success: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(success);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  function inferredQuickCreateDefaults(): QuickCreateDefaults | undefined {
    const match = href.match(/^\/contacts\/([^/?#]+)/);
    if (!match) return undefined;
    return {
      contactId: decodeURIComponent(match[1]),
      contactLabel: label,
      revalidate: href,
    };
  }

  function run(action: RecordContextAction) {
    if (action.quickCreate) {
      openQuickCreate(
        action.quickCreate,
        action.quickCreateDefaults ?? inferredQuickCreateDefaults(),
      );
    } else if (action.copyValue) {
      void copy(action.copyValue, `${action.label.replace(/^Copy /, "")} copied`);
    } else if (action.href) {
      navigate(action.href, action.newTab);
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-56">
        <ContextMenuLabel className="max-w-64 truncate">{label}</ContextMenuLabel>
        <ContextMenuItem onSelect={() => navigate(href, openInNewTab)}>
          <ExternalLink />
          Open
          <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        {!openInNewTab && <ContextMenuItem onSelect={() => navigate(href, true)}>
          <ExternalLink />
          Open in new tab
        </ContextMenuItem>}
        {actions.map((action, index) => {
          const Icon = action.icon ? ACTION_ICONS[action.icon] : ExternalLink;
          return (
            <Fragment key={`${action.label}-${index}`}>
              {action.separatorBefore && <ContextMenuSeparator />}
              <ContextMenuItem onSelect={() => run(action)}>
                <Icon />
                {action.label}
              </ContextMenuItem>
            </Fragment>
          );
        })}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            void copy(new URL(href, window.location.origin).toString(), "Record link copied")
          }
        >
          <Copy />
          Copy link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
