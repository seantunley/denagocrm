"use client"

import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { usePathname } from "next/navigation"
import { Layer } from "./layer"
import { dialogVisible, initialDialogNavState, nextDialogNavState } from "./dialogNavigation"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/**
 * A dialog belongs to the page it was opened on.
 *
 * When something inside it navigates (Countersign & review → the signing page,
 * a product link in Settings → the product page), the app routes UNDERNEATH the
 * dialog, which stayed open on top: the new page was there but hidden (Sean,
 * 2026-09-30, "opened something in the background that I could not see").
 * So an open dialog hides as soon as the PATHNAME changes from the one it
 * opened on. Query-only changes (?edit=, ?tab=) don't close it.
 *
 * It hides rather than calling onOpenChange(false): for route modals that
 * callback is router.back(), which would undo the very navigation that closed it.
 * The dismissal is sticky until the dialog is really reopened (dialogNavigation).
 *
 * Uncontrolled dialogs (DialogTrigger, no `open` prop) are covered too: their
 * open state is held here, and closed outright when navigation dismisses them.
 */
function Dialog({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const pathname = usePathname()
  const controlled = openProp !== undefined
  const [internalOpen, setInternalOpen] = React.useState(Boolean(defaultOpen))
  const open = controlled ? Boolean(openProp) : internalOpen

  // "Adjust state during render", so a reopen always starts fresh.
  const [nav, setNav] = React.useState(() => initialDialogNavState(open, pathname))
  const next = nextDialogNavState(nav, open, pathname)
  if (next !== nav) {
    setNav(next)
    // An uncontrolled dialog has no owner to keep it "open": close it for real.
    if (!controlled && next.dismissed) setInternalOpen(false)
  }

  const handleOpenChange = (value: boolean) => {
    if (!controlled) setInternalOpen(value)
    onOpenChange?.(value)
  }
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      open={dialogVisible(next, open)}
      onOpenChange={handleOpenChange}
      {...props}
    />
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  // Overlay + content share one layer, taken when the dialog opens (./layer).
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal" {...props}>
      <Layer>{children}</Layer>
    </DialogPrimitive.Portal>
  )
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-1.5rem)] translate-x-[-50%] translate-y-[-50%] gap-3 rounded-lg border border-white/20 bg-background p-4 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-3 right-3 z-20 grid size-8 place-items-center rounded-lg bg-background/80 text-muted-foreground opacity-80 ring-offset-background backdrop-blur-sm transition hover:bg-accent hover:text-foreground hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      className={cn(
        "max-h-[calc(100dvh-.75rem)] overflow-y-auto rounded-xl border-border bg-background p-4 max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-4",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-muted-foreground/25 sm:hidden" />
      {children}
    </DialogContent>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 pr-12 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
}
