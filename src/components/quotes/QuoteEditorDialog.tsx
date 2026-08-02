"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  Ban,
  Check,
  Clock3,
  ExternalLink,
  Eye,
  FileClock,
  FileText,
  History,
  Loader2,
  LockKeyhole,
  MessageSquareWarning,
  PackageOpen,
  RefreshCw,
  Undo2,
  PenLine,
  Plus,
  Printer,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  canDeleteQuote,
  createQuoteRevision,
  deleteQuote,
  quoteEditorRecord,
  saveQuoteDraft,
  setQuoteStatus,
  type QuoteDraftInput,
} from "@/app/actions/quotes";
import { recordCustomFields, saveCustomFieldValues } from "@/app/actions/customFields";
import type { FieldWithValue } from "@/lib/customFields-helpers";
import ConfirmDelete from "@/components/ConfirmDelete";
import CustomFieldsForm from "@/components/custom-fields/CustomFieldsForm";
import { quoteSigningView } from "@/app/actions/recordSigning";
import type { QuoteSigningView } from "@/lib/signing/record";
import { feeRows, quotePricing } from "@/lib/pricing";
import SigningBlock from "@/components/SigningBlock";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FeedbackBanner, StatusPill } from "@/components/visual-system";
import { cn } from "@/lib/utils";

export type QuoteEditorContact = {
  id: string;
  label: string;
};

export type QuoteEditorLead = {
  id: string;
  label: string;
  contactId: string | null;
};

export type QuoteEditorProduct = {
  id: string;
  name: string;
  basePriceCents: number;
  colors: string[];
};

export type QuoteEditorVersion = {
  id: string;
  number: number;
  status: string;
  createdAt: string;
  superseded: boolean;
  current: boolean;
};

export type QuoteEditorRecord = {
  id: string;
  number: number;
  status: string;
  contactId: string | null;
  contactLabel: string;
  leadId: string | null;
  leadLabel: string | null;
  validUntil: string;
  terms: string;
  createdAt: string;
  createdByName: string | null;
  editable: boolean;
  lockedReason: string | null;
  /** Set once a revision supersedes this version — links to the one that did. */
  supersededAt: string | null;
  supersededById: string | null;
  supersededByNumber: number | null;
  /** The customer asked for changes from the signing page rather than signing. */
  changeRequestedAt: string | null;
  changeRequestNote: string | null;
  items: Array<{
    id: string;
    description: string;
    qty: number;
    unitPriceCents: number;
    productId: string | null;
    colorPreference: string | null;
    discountPct: number;
    /** Unit cost basis. No surface edits it, but the margin figure needs it and
     *  a save must not reset it — see saveQuoteDraft's carry-forward. */
    costCents: number;
    /** A customer-selectable add-on, and whether they took it. Also unedited
     *  anywhere, but an unselected one is NOT charged, so pricing it as a normal
     *  line would print an amount the total never counted. */
    optional: boolean;
    selected: boolean;
  }>;
  taxInclusive: boolean;
  depositType: string | null;
  depositValue: number | null;
  fees: Array<{ id: string; label: string; kind: string; amountCents: number }>;
  versions: QuoteEditorVersion[];
};

export type QuoteEditorDefaults = {
  validUntil: string;
  terms: string;
};

type DraftLine = {
  key: string;
  /**
   * The QuoteItem row this line edits, or null when it is a new line. Sent back
   * on save so the server can carry across the CPQ columns no surface edits —
   * cost basis, optional/selected, per-line VAT — instead of resetting them.
   */
  id: string | null;
  kind: "catalogue" | "custom";
  description: string;
  qty: string;
  unitPrice: string;
  discount: string;
  productId: string | null;
  colorPreference: string;
  /** Carried, not edited — the margin figure is computed from it. */
  costCents: number;
  /** Carried, not edited — an unselected add-on is offered but not charged. */
  optional: boolean;
  selected: boolean;
};

type DraftFee = {
  key: string;
  id: string | null;
  label: string;
  kind: "fee" | "delivery";
  amount: string;
};

type DraftState = {
  contactId: string;
  leadId: string;
  validUntil: string;
  terms: string;
  lines: DraftLine[];
  fees: DraftFee[];
  taxInclusive: boolean;
  depositType: "" | "percent" | "amount";
  depositValue: string;
};

type SavedQuote = {
  id: string;
  number: number;
  status: string;
} | null;

let lineSequence = 0;

function lineKey() {
  lineSequence += 1;
  return `quote-line-${lineSequence}`;
}

function feeKey() {
  lineSequence += 1;
  return `quote-fee-${lineSequence}`;
}

function rands(cents: number) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function priceInput(cents: number) {
  return (cents / 100).toFixed(2);
}

function centsFromInput(value: string) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN;
}

function createDraft(
  record: QuoteEditorRecord | null,
  defaults: QuoteEditorDefaults,
  initialContactId: string | undefined,
  products: QuoteEditorProduct[],
) {
  if (!record) {
    return {
      contactId: initialContactId ?? "",
      leadId: "",
      validUntil: defaults.validUntil,
      terms: defaults.terms,
      lines: [],
      fees: [],
      taxInclusive: true,
      depositType: "",
      depositValue: "",
    } satisfies DraftState;
  }
  return {
    contactId: record.contactId ?? "",
    leadId: "", // existing quotes keep their server-side lead link; not editable here
    validUntil: record.validUntil,
    terms: record.terms,
    fees: record.fees.map((fee) => ({
      key: fee.id,
      id: fee.id,
      label: fee.label,
      kind: fee.kind === "delivery" ? "delivery" : "fee",
      amount: (fee.amountCents / 100).toFixed(2),
    })),
    taxInclusive: record.taxInclusive,
    depositType: record.depositType === "percent" || record.depositType === "amount" ? record.depositType : "",
    depositValue: record.depositValue != null ? String(record.depositValue) : "",
    lines: record.items.map((item) => {
      const matchingProduct = item.productId
        ? products.find((product) => product.id === item.productId)
        : products.find((product) => product.name.trim().toLowerCase() === item.description.trim().toLowerCase());
      return {
        key: item.id,
        id: item.id,
        kind: item.productId || matchingProduct ? "catalogue" : "custom",
        description: item.description,
        qty: String(item.qty),
        unitPrice: priceInput(item.unitPriceCents),
        discount: item.discountPct ? String(item.discountPct) : "",
        productId: item.productId ?? matchingProduct?.id ?? null,
        colorPreference: item.colorPreference ?? "",
        costCents: item.costCents,
        optional: item.optional,
        selected: item.selected,
      };
    }),
  } satisfies DraftState;
}

function draftSnapshot(draft: DraftState) {
  return JSON.stringify({
    contactId: draft.contactId,
    leadId: draft.leadId,
    validUntil: draft.validUntil,
    terms: draft.terms,
    taxInclusive: draft.taxInclusive,
    depositType: draft.depositType,
    depositValue: draft.depositValue,
    fees: draft.fees.map(({ label, kind, amount }) => ({ label, kind, amount })),
    lines: draft.lines.map(({ kind, description, qty, unitPrice, discount, productId, colorPreference }) => ({
      kind,
      description,
      qty,
      unitPrice,
      discount,
      productId,
      colorPreference,
    })),
  });
}

function statusTone(status: string): "neutral" | "success" | "danger" | "info" {
  if (status === "accepted") return "success";
  if (status === "declined") return "danger";
  if (status === "sent") return "info";
  return "neutral";
}

function displayDate(value: string) {
  if (!value) return "Not set";
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function QuoteEditorDialog({
  open,
  onOpenChange,
  contacts,
  leads = [],
  products,
  defaults,
  record = null,
  initialContactId,
  onOpenQuote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: QuoteEditorContact[];
  leads?: QuoteEditorLead[];
  products: QuoteEditorProduct[];
  defaults: QuoteEditorDefaults;
  record?: QuoteEditorRecord | null;
  initialContactId?: string;
  /**
   * Switch the editor to a different quote. Creating a revision produces a new
   * quote, and pushing `/quotes?edit=<id>` cannot open it from here — the
   * provider reads that param once, on mount, so a soft navigation within
   * /quotes changes the URL and nothing else.
   */
  onOpenQuote?: (quoteId: string) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftState>(() => createDraft(record, defaults, initialContactId, products));
  const [initialSnapshot, setInitialSnapshot] = useState(() => draftSnapshot(draft));
  const [savedQuote, setSavedQuote] = useState<SavedQuote>(
    record ? { id: record.id, number: record.number, status: record.status } : null,
  );
  const [activeTab, setActiveTab] = useState("build");
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  /** Set when the discard prompt was raised by switching versions, not closing. */
  const [pendingVersionId, setPendingVersionId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /**
   * Signing state for the Send tab's signature card.
   *
   * It cannot ride in on `record`: the editor can CREATE the quote it is about
   * to send, so at open time there may be no record at all — and once the card
   * acts, router.refresh() re-renders the page underneath the dialog without
   * ever reaching these props. So it is fetched for whichever quote currently
   * exists and refetched whenever the card changes something.
   */
  const [signingNonce, setSigningNonce] = useState(0);
  const reloadSigning = useCallback(() => setSigningNonce((nonce) => nonce + 1), []);
  const signingQuoteId = savedQuote?.id ?? null;
  // The fetch carries the id it answered for, so which quote the state belongs
  // to is derived at render rather than reset through the effect — a refetch
  // then keeps showing the last good card instead of flashing a spinner.
  const [signingFetch, setSigningFetch] = useState<{ quoteId: string; view: QuoteSigningView | null; canDelete: boolean; customFields: FieldWithValue[] } | null>(null);
  const signing = signingFetch?.quoteId === signingQuoteId ? signingFetch.view : null;
  const signingReady = !signingQuoteId || signingFetch?.quoteId === signingQuoteId;
  // Until the answer arrives, assume NOT permitted: a control that starts
  // enabled and greys out a moment later invites the click it is meant to stop.
  const canDelete = signingFetch?.quoteId === signingQuoteId && signingFetch.canDelete;
  const customFields = signingFetch?.quoteId === signingQuoteId ? signingFetch.customFields : [];

  useEffect(() => {
    if (!signingQuoteId) return;
    let live = true;
    // Two questions about the same quote, asked together. They are separate
    // actions because they enforce separate permissions — signing state is
    // gated on quotes.change_status, deleting on quotes.delete — and each
    // belongs with the rules it mirrors.
    Promise.all([
      quoteSigningView(signingQuoteId),
      canDeleteQuote(signingQuoteId),
      recordCustomFields("quote", signingQuoteId),
    ])
      .then(([view, deletable, customFields]) => {
        if (!live) return;
        setSigningFetch({ quoteId: signingQuoteId, view, canDelete: deletable, customFields });
        // Signing moves the quote's own status server-side — dispatch marks it
        // sent once the link is out, voiding puts it back to draft. Adopt it,
        // or the header keeps showing whatever the dialog opened with.
        if (view) {
          setSavedQuote((current) =>
            current && current.id === signingQuoteId && current.status !== view.status
              ? { ...current, status: view.status }
              : current,
          );
        }
      })
      .catch(() => {
        if (live) setSigningFetch({ quoteId: signingQuoteId, view: null, canDelete: false, customFields: [] });
      });
    return () => {
      live = false;
    };
  }, [signingQuoteId, signingNonce]);

  const currentSnapshot = useMemo(() => draftSnapshot(draft), [draft]);
  const dirty = currentSnapshot !== initialSnapshot;
  const currentStatus = savedQuote?.status ?? record?.status ?? "draft";
  // A live signing request locks the quote. `record.lockedReason` is computed
  // when the list page renders, so it knows nothing about a request started
  // from this dialog a moment ago — the fetched state does.
  const editable = (record?.editable ?? true) && currentStatus === "draft" && !signing?.locked;
  const lockedReason = signing?.locked
    ? "A signing request is out with the customer. Void it in the Send tab before making changes."
    : record?.lockedReason ?? "Create a revision from the full quote record to make changes.";
  // Lifecycle gates, matching the record page exactly: a signed or superseded
  // version is permanently read-only, only a sent quote can be decided, only an
  // already-decided one can go back to draft, and a revision may be cut from a
  // quote the customer has seen. The server re-checks all of it.
  const permanentlyReadOnly = Boolean(signing?.signedAt || record?.supersededAt);
  const canDecide = !permanentlyReadOnly && currentStatus === "sent";
  const canReopen = !permanentlyReadOnly && (currentStatus === "accepted" || currentStatus === "declined");
  const canRevise = !permanentlyReadOnly && (currentStatus === "sent" || currentStatus === "declined");
  // What deleting actually does, beyond moving it to Trash. deleteQuote() voids
  // any live signing request and reopens the lead behind an accepted quote —
  // both worth knowing BEFORE confirming, and especially here, where the link
  // to the customer may have gone out moments ago in the tab next door.
  const deleteConsequences = [
    "The quote moves to the Trash and can be restored for 60 days.",
    signing?.locked ? "The signing request out with the customer is voided immediately." : null,
    currentStatus === "accepted" ? "Its lead reopens, because the sale stops counting." : null,
  ]
    .filter(Boolean)
    .join(" ");
  const customerLabel = contacts.find((contact) => contact.id === draft.contactId)?.label ?? "Customer not selected";

  const calculated = useMemo(() => {
    const lines = draft.lines.map((line) => ({
      qty: Number(line.qty.replace(",", ".")) || 0,
      unitPriceCents: centsFromInput(line.unitPrice) || 0,
      discountPct: Number(line.discount.replace(",", ".")) || 0,
      taxRatePct: 15,
      costCents: line.costCents,
      // An add-on the customer declined is offered, not charged — quotePricing
      // leaves it out of the total, so it must not be priced as a normal row.
      optional: line.optional,
      selected: line.selected,
    }));
    // Built in the same shape — and with the same label fallback and zero
    // filter — as the save path, so the preview itemises exactly the fees the
    // saved quote will charge for.
    const fees = draft.fees
      .map((fee) => ({
        label: fee.label.trim() || (fee.kind === "delivery" ? "Delivery" : "Fee"),
        kind: fee.kind,
        amountCents: centsFromInput(fee.amount) || 0,
        taxRatePct: 15,
      }))
      .filter((fee) => fee.amountCents !== 0);
    const p = quotePricing(lines, fees, {
      taxInclusive: draft.taxInclusive,
      depositType: draft.depositType || null,
      depositValue: draft.depositValue ? Number(draft.depositValue.replace(",", ".")) : null,
    });
    return {
      subtotal: p.netCents,
      vat: p.taxCents,
      fees: p.feesTotalCents,
      total: p.totalCents,
      deposit: p.depositCents,
      balance: p.balanceCents,
      // Line net less cost. Shown only when a cost basis exists — nothing in the
      // app sets one today, so a zero-cost quote would otherwise report 100%.
      margin: p.marginCents,
      marginPct: p.marginPct,
      hasCost: p.costCents > 0,
      // Fees and delivery are counted in the total, so the preview prints them
      // as rows too — a total that exceeds the visible lines is a quote the
      // customer can't check. Same helper the printed document uses.
      feeLines: feeRows(fees),
    };
  }, [draft.lines, draft.fees, draft.taxInclusive, draft.depositType, draft.depositValue]);

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  }

  function addProductLine() {
    if (!editable) return;
    setDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          key: lineKey(),
          id: null,
          costCents: 0,
          optional: false,
          selected: true,
          kind: "catalogue",
          description: "",
          qty: "1",
          unitPrice: "0.00",
          discount: "",
          productId: null,
          colorPreference: "",
        },
      ],
    }));
  }

  function selectProduct(key: string, productId: string) {
    const product = products.find((candidate) => candidate.id === productId);
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => {
        if (line.key !== key) return line;
        if (!product) {
          return { ...line, productId: null, description: "", unitPrice: "0.00", colorPreference: "" };
        }
        return {
          ...line,
          productId: product.id,
          description: product.name,
          unitPrice: priceInput(product.basePriceCents),
          colorPreference: line.productId === product.id ? line.colorPreference : "",
        };
      }),
    }));
  }

  function addCustomLine() {
    if (!editable) return;
    setDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          key: lineKey(),
          id: null,
          costCents: 0,
          optional: false,
          selected: true,
          kind: "custom",
          description: "",
          qty: "1",
          unitPrice: "0.00",
          discount: "",
          productId: null,
          colorPreference: "",
        },
      ],
    }));
  }

  function removeLine(key: string) {
    if (!editable) return;
    setDraft((current) => ({ ...current, lines: current.lines.filter((line) => line.key !== key) }));
  }

  function addFee(kind: "fee" | "delivery") {
    if (!editable) return;
    setDraft((current) => ({
      ...current,
      fees: [...current.fees, { key: feeKey(), id: null, label: kind === "delivery" ? "Delivery" : "", kind, amount: "0.00" }],
    }));
  }

  function updateFee(key: string, patch: Partial<DraftFee>) {
    setDraft((current) => ({ ...current, fees: current.fees.map((fee) => (fee.key === key ? { ...fee, ...patch } : fee)) }));
  }

  function removeFee(key: string) {
    if (!editable) return;
    setDraft((current) => ({ ...current, fees: current.fees.filter((fee) => fee.key !== key) }));
  }

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen && dirty && !isPending) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(nextOpen);
  }

  /**
   * Switch the editor to another version of this quote.
   *
   * "Open" used to be a Link to /quotes/<id>. From inside an open modal that
   * navigated the page UNDERNEATH the overlay — the route changed and the
   * dialog stayed put, so the button did nothing you could see. Swapping the
   * editor over keeps it in one place, and works the same for a superseded
   * version as for the current one.
   */
  function requestOpenVersion(quoteId: string) {
    if (!onOpenQuote || quoteId === savedQuote?.id) return;
    if (dirty && !isPending) {
      setPendingVersionId(quoteId);
      setDiscardOpen(true);
      return;
    }
    onOpenQuote(quoteId);
  }

  function discardAndClose() {
    setDiscardOpen(false);
    // The same prompt guards both exits — leaving the editor, and leaving this
    // version for another one. Only the destination differs.
    if (pendingVersionId) {
      const target = pendingVersionId;
      setPendingVersionId(null);
      onOpenQuote?.(target);
      return;
    }
    onOpenChange(false);
  }

  /**
   * The lifecycle moves that used to live only on the record page: accept,
   * decline, back to draft, and revise.
   *
   * Each is the same server action that page called, and each returns a refusal
   * as a VALUE — "out for signature, void the request first", "can no longer be
   * changed" — so a blocked transition explains itself in the banner instead of
   * appearing to do nothing.
   */
  function runLifecycle(
    done: string,
    run: () => Promise<{ error?: string; redirectTo?: string } | void>,
  ) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await run();
        if (result?.error) {
          // Toast AND banner: these buttons live in the header, so the click can
          // come from any tab — and Preview and Versions have nowhere to put a
          // banner. The banner still carries it for Build and Send.
          setError(result.error);
          toast.error(result.error);
          return;
        }
        toast.success(done);
        if (result?.redirectTo) {
          // A revision is a different quote. Hand the id to the provider so the
          // editor swaps to it in place; only fall back to navigating when the
          // dialog has no provider to tell (Quick Create).
          const revisionId = result.redirectTo.split("edit=")[1];
          if (onOpenQuote && revisionId) {
            onOpenQuote(revisionId);
            // The list underneath is now wrong in two ways — the revision is
            // missing and the quote it superseded is still shown as current.
            router.refresh();
          } else {
            router.push(result.redirectTo);
          }
          return;
        }
        reloadSigning();
        router.refresh();
      } catch {
        setError("That change could not be applied. Please try again.");
      }
    });
  }

  function save(intent: "draft" | "sent", opts?: { thenSign?: boolean }) {
    setError(null);
    if (!draft.contactId) {
      setError("Select a customer before saving the quote.");
      setActiveTab("build");
      return;
    }

    const items: QuoteDraftInput["items"] = [];
    for (const line of draft.lines) {
      if (line.kind === "catalogue" && !line.productId) {
        setError("Select a product for every catalogue line.");
        setActiveTab("build");
        return;
      }
      const description = line.description.trim();
      const qty = Number(line.qty.replace(",", "."));
      const unitPriceCents = centsFromInput(line.unitPrice);
      if (!description) {
        setError("Every quote line needs a description.");
        setActiveTab("build");
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`Enter a valid quantity for “${description}”.`);
        setActiveTab("build");
        return;
      }
      if (!Number.isFinite(unitPriceCents) || unitPriceCents < 0) {
        setError(`Enter a valid price for “${description}”.`);
        setActiveTab("build");
        return;
      }
      const discountPct = line.discount.trim() ? Number(line.discount.replace(",", ".")) : 0;
      if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
        setError(`Enter a discount between 0 and 100 for “${description}”.`);
        setActiveTab("build");
        return;
      }
      items.push({
        // Identifies the row being edited, so the server keeps the CPQ columns
        // this editor never shows rather than resetting them to defaults.
        id: line.id,
        description,
        qty,
        unitPriceCents,
        discountPct,
        productId: line.productId,
        colorPreference: line.colorPreference.trim() || null,
      });
    }

    const fees = draft.fees
      .map((fee) => ({
        id: fee.id,
        label: fee.label.trim() || (fee.kind === "delivery" ? "Delivery" : "Fee"),
        kind: fee.kind,
        amountCents: centsFromInput(fee.amount),
      }))
      .filter((fee) => Number.isFinite(fee.amountCents) && fee.amountCents !== 0);

    startTransition(async () => {
      try {
        const result = await saveQuoteDraft({
          id: savedQuote?.id,
          contactId: draft.contactId,
          leadId: draft.leadId || null,
          validUntil: draft.validUntil || null,
          terms: draft.terms,
          intent,
          items,
          fees,
          taxInclusive: draft.taxInclusive,
          depositType: draft.depositType || null,
          depositValue: draft.depositValue ? Number(draft.depositValue.replace(",", ".")) : null,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSavedQuote(result.quote);
        setInitialSnapshot(currentSnapshot);
        setError(null);
        // The quote may have just come into existence, or its lifecycle may have
        // moved — either way the signature card is now looking at stale facts.
        reloadSigning();
        if (opts?.thenSign) setActiveTab("send");
        toast.success(intent === "sent" ? `Quote Q-${result.quote.number} marked sent` : `Quote Q-${result.quote.number} saved`);
        router.refresh();
      } catch {
        setError("The quote could not be saved. Please try again.");
      }
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={requestOpenChange}>
        <ResponsiveDialogContent
          data-quote-editor="true"
          showCloseButton
          className="z-[100] flex h-[min(900px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] w-[min(1200px,calc(100vw-2rem))] max-w-none flex-col gap-0 !overflow-hidden border-white/10 bg-[#0d100f] p-0 shadow-[0_32px_120px_rgba(0,0,0,.78)] sm:max-w-none max-sm:inset-0 max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
        >
          <DialogHeader className="shrink-0 border-b border-white/[0.08] bg-[#101411] px-5 py-4 pr-14 text-left sm:px-6">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="grid size-9 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                <FileText className="size-[18px]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="truncate text-xl tracking-[-0.03em]">
                    {savedQuote ? `Quote Q-${savedQuote.number}` : "New quote"}
                  </DialogTitle>
                  <StatusPill tone={statusTone(currentStatus)}>{currentStatus}</StatusPill>
                </div>
                {/*
                  The customer and lead were plain text, so the editor was a
                  dead end for "who is this and where did it come from" — the
                  record page's links were the only way through.
                */}
                <DialogDescription className="mt-1 truncate">
                  {record?.contactId ? (
                    <Link href={`/contacts/${record.contactId}`} className="text-primary hover:underline">{customerLabel}</Link>
                  ) : (
                    customerLabel
                  )}
                  {record?.leadLabel && (
                    <>
                      {" · "}
                      {record.leadId ? (
                        <Link href={`/leads/${record.leadId}`} className="text-primary hover:underline">{record.leadLabel}</Link>
                      ) : (
                        record.leadLabel
                      )}
                    </>
                  )}
                  {record?.createdByName && <span className="text-muted-foreground"> · by {record.createdByName}</span>}
                </DialogDescription>
              </div>
              {/*
                What happened next: accept, decline, reopen, revise.

                In the header rather than inside a tab, because that is where
                the record page kept them and because they are not "sending" —
                they describe the deal, and you reach for them from whichever
                tab you happen to be on. Buried one tab deep, they read as
                missing.
              */}
              {savedQuote && (canDecide || canReopen || canRevise) && (
                <div className="flex flex-wrap items-center gap-2">
                  {canDecide && (
                    <>
                      <Button type="button" size="sm" variant="outline" disabled={isPending} title="Records the sale and wins the linked lead. A quote out for signature must have its request voided first." onClick={() => runLifecycle(`Quote Q-${savedQuote.number} accepted 🎉`, () => setQuoteStatus(savedQuote.id, "accepted"))}><Check />Accepted</Button>
                      <Button type="button" size="sm" variant="outline" disabled={isPending} title="Marks the quote declined by the customer." onClick={() => runLifecycle(`Quote Q-${savedQuote.number} declined`, () => setQuoteStatus(savedQuote.id, "declined"))}><Ban />Declined</Button>
                    </>
                  )}
                  {canReopen && (
                    <Button type="button" size="sm" variant="outline" disabled={isPending} title="Reopens this version for editing." onClick={() => runLifecycle(`Quote Q-${savedQuote.number} back to draft`, () => setQuoteStatus(savedQuote.id, "draft"))}><Undo2 />Back to draft</Button>
                  )}
                  {canRevise && (
                    <Button type="button" size="sm" variant="outline" disabled={isPending} title="Copies everything into a fresh draft and supersedes this version. The editor switches to the revision." onClick={() => runLifecycle("Revision created", () => createQuoteRevision(savedQuote.id))}><RefreshCw />Revise</Button>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {isPending ? <Loader2 className="size-3.5 animate-spin text-primary" /> : dirty ? <Clock3 className="size-3.5 text-amber-300" /> : <Check className="size-3.5 text-emerald-400" />}
                <span>{isPending ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}</span>
              </div>
            </div>
          </DialogHeader>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 overflow-x-auto border-b border-white/[0.07] bg-[#0f1211] px-4 sm:px-6">
              <TabsList variant="line" className="h-12 min-w-max gap-4 p-0">
                <TabsTrigger value="build" className="gap-2 px-1"><FileText />Build</TabsTrigger>
                <TabsTrigger value="preview" className="gap-2 px-1"><Eye />Preview</TabsTrigger>
                <TabsTrigger value="versions" className="gap-2 px-1"><History />Versions</TabsTrigger>
                <TabsTrigger value="send" className="gap-2 px-1"><Send />Send</TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <TabsContent value="build" className="h-full overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
                  <div className="min-w-0 space-y-5">
                    {error && <FeedbackBanner tone="danger" title="Quote not saved">{error}</FeedbackBanner>}
                    {!editable && (
                      <FeedbackBanner tone="warning" title="This quote is read-only">
                        {lockedReason}
                        {/* A superseded version is a dead end without this — it
                            says it is old but not which quote replaced it. */}
                        {record?.supersededById && (
                          <>
                            {" "}
                            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onOpenQuote?.(record.supersededById!)}>
                              Open Q-{record.supersededByNumber} instead
                            </button>
                          </>
                        )}
                      </FeedbackBanner>
                    )}
                    {/*
                      The customer asked for changes from the signing page
                      instead of signing. Without this the request was invisible
                      in the editor — you saw an unsigned quote and no reason.
                    */}
                    {record?.changeRequestedAt && !record.supersededAt && !signing?.signedAt && (
                      <FeedbackBanner tone="info" title={`Customer requested changes on ${record.changeRequestedAt}`}>
                        <span className="flex flex-col gap-2">
                          <span className="flex items-start gap-2">
                            <MessageSquareWarning className="mt-0.5 size-4 shrink-0" />
                            <span>{record.changeRequestNote || "No note was left — follow up with the customer."}</span>
                          </span>
                          {canRevise && savedQuote && (
                            <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => runLifecycle("Revision created", () => createQuoteRevision(savedQuote.id))} disabled={isPending}>
                              <RefreshCw />Create revision
                            </Button>
                          )}
                        </span>
                      </FeedbackBanner>
                    )}

                    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-semibold">Customer</p>
                          <p className="mt-1 text-xs text-muted-foreground">The quote and future signing request will be linked to this customer.</p>
                        </div>
                        {record?.leadLabel && <StatusPill tone="info">Lead linked</StatusPill>}
                      </div>
                      <label className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="quote-customer">Customer</label>
                      <select
                        id="quote-customer"
                        className="input mt-1.5"
                        value={draft.contactId}
                        disabled={!editable || Boolean(record?.leadLabel)}
                        onChange={(event) => setDraft((current) => ({ ...current, contactId: event.target.value }))}
                      >
                        <option value="">Select a customer…</option>
                        {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.label}</option>)}
                      </select>
                      {/* Optional lead link — only when starting a fresh quote. Picking a
                          lead ties the quote to it (so it shows on the lead) and fills in
                          the customer from that lead. Existing quotes keep their own link. */}
                      {!record && leads.length > 0 && (
                        <>
                          <label className="mt-4 block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" htmlFor="quote-lead">Link to a lead (optional)</label>
                          <select
                            id="quote-lead"
                            className="input mt-1.5"
                            value={draft.leadId}
                            disabled={!editable}
                            onChange={(event) => {
                              const leadId = event.target.value;
                              const lead = leads.find((item) => item.id === leadId);
                              setDraft((current) => ({
                                ...current,
                                leadId,
                                // Keep the customer in step with the chosen lead.
                                contactId: lead?.contactId ?? current.contactId,
                              }));
                            }}
                          >
                            <option value="">No lead — customer quote</option>
                            {leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.label}</option>)}
                          </select>
                          <p className="mt-1.5 text-xs text-muted-foreground">Links this quote to the lead so it appears on the lead&apos;s record.</p>
                        </>
                      )}
                    </section>

                    <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-5">
                        <div>
                          <p className="text-sm font-semibold">Line items</p>
                          <p className="mt-1 text-xs text-muted-foreground">{draft.lines.length} {draft.lines.length === 1 ? "line" : "lines"} · prices include VAT</p>
                        </div>
                        {editable && (
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={addProductLine} disabled={products.length === 0}><Plus />Product line</Button>
                            <Button type="button" variant="ghost" size="sm" onClick={addCustomLine}><Plus />Custom line</Button>
                          </div>
                        )}
                      </div>
                      {draft.lines.length === 0 ? (
                        <div className="px-5 py-12 text-center">
                          <PackageOpen className="mx-auto size-7 text-muted-foreground" />
                          <p className="mt-3 text-sm font-medium">No quote lines yet</p>
                          <p className="mt-1 text-xs text-muted-foreground">Choose a catalogue product or add a custom line.</p>
                        </div>
                      ) : (
                        <div className="divide-y divide-white/[0.07]">
                          {draft.lines.map((line, index) => {
                            const selectedProduct = line.productId
                              ? products.find((product) => product.id === line.productId)
                              : null;
                            return (
                            <div key={line.key} className="grid gap-3 px-4 py-4 sm:grid-cols-[2rem_minmax(0,1fr)_5rem_8rem_5rem_2.25rem] sm:items-end sm:px-5">
                              <span className="hidden pb-2 text-xs font-semibold tabular-nums text-muted-foreground sm:block">{String(index + 1).padStart(2, "0")}</span>
                              <div className="min-w-0">
                                <label className="label" htmlFor={`${line.key}-description`}>Description</label>
                                {line.kind === "catalogue" ? (
                                  <select
                                    id={`${line.key}-description`}
                                    className="input"
                                    value={line.productId ?? ""}
                                    disabled={!editable}
                                    onChange={(event) => selectProduct(line.key, event.target.value)}
                                  >
                                    <option value="">Select a product…</option>
                                    {line.productId && !selectedProduct && <option value={line.productId}>{line.description} (unavailable)</option>}
                                    {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                                  </select>
                                ) : (
                                  <input id={`${line.key}-description`} className="input" value={line.description} disabled={!editable} onChange={(event) => updateLine(line.key, { description: event.target.value })} />
                                )}
                                {/* Staff need to see what was offered, so a
                                    declined add-on stays listed here — the
                                    customer's copy drops it, and the total has
                                    never counted it. */}
                                {line.optional && !line.selected && (
                                  <p className="mt-2 text-xs text-amber-300/80">Optional — not selected, so it isn&apos;t charged.</p>
                                )}
                                {selectedProduct && selectedProduct.colors.length > 0 && (
                                  <div className="mt-3 rounded-xl border border-primary/15 bg-primary/[0.045] p-3">
                                    <div className="flex items-center justify-between gap-3">
                                      <label className="label mb-0" htmlFor={`${line.key}-colour`}>Colour preference</label>
                                      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">Catalogue EV</span>
                                    </div>
                                    <select
                                      id={`${line.key}-colour`}
                                      className="input mt-1.5"
                                      value={line.colorPreference}
                                      disabled={!editable}
                                      onChange={(event) => updateLine(line.key, { colorPreference: event.target.value })}
                                    >
                                      <option value="">No preference</option>
                                      {selectedProduct.colors.map((colour) => <option key={colour} value={colour}>{colour}</option>)}
                                    </select>
                                  </div>
                                )}
                              </div>
                              <div>
                                <label className="label" htmlFor={`${line.key}-qty`}>Qty</label>
                                <input id={`${line.key}-qty`} className="input" inputMode="decimal" value={line.qty} disabled={!editable} onChange={(event) => updateLine(line.key, { qty: event.target.value })} />
                              </div>
                              <div>
                                <label className="label" htmlFor={`${line.key}-price`}>Unit price (R)</label>
                                <input id={`${line.key}-price`} className="input" inputMode="decimal" value={line.unitPrice} disabled={!editable} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} />
                              </div>
                              <div>
                                <label className="label" htmlFor={`${line.key}-discount`}>Disc %</label>
                                <input id={`${line.key}-discount`} className="input" inputMode="decimal" placeholder="0" value={line.discount} disabled={!editable} onChange={(event) => updateLine(line.key, { discount: event.target.value })} />
                              </div>
                              {editable && (
                                <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-red-300" onClick={() => removeLine(line.key)} aria-label={`Remove line ${index + 1}`}>
                                  <Trash2 />
                                </Button>
                              )}
                            </div>
                            );
                          })}
                        </div>
                      )}
                    </section>

                    <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-5">
                        <div>
                          <p className="text-sm font-semibold">Fees &amp; delivery</p>
                          <p className="mt-1 text-xs text-muted-foreground">Delivery charges, admin or other fees (VAT at 15%).</p>
                        </div>
                        {editable && (
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => addFee("delivery")}><Plus />Delivery</Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => addFee("fee")}><Plus />Fee</Button>
                          </div>
                        )}
                      </div>
                      {draft.fees.length === 0 ? (
                        <div className="px-5 py-8 text-center text-xs text-muted-foreground">No fees or delivery charges added.</div>
                      ) : (
                        <div className="divide-y divide-white/[0.07]">
                          {draft.fees.map((fee) => (
                            <div key={fee.key} className="grid gap-3 px-4 py-4 sm:grid-cols-[8rem_minmax(0,1fr)_8rem_2.25rem] sm:items-end sm:px-5">
                              <div>
                                <label className="label" htmlFor={`${fee.key}-kind`}>Type</label>
                                <select id={`${fee.key}-kind`} className="input" value={fee.kind} disabled={!editable} onChange={(event) => updateFee(fee.key, { kind: event.target.value as DraftFee["kind"] })}>
                                  <option value="delivery">Delivery</option>
                                  <option value="fee">Fee</option>
                                </select>
                              </div>
                              <div className="min-w-0">
                                <label className="label" htmlFor={`${fee.key}-label`}>Label</label>
                                <input id={`${fee.key}-label`} className="input" value={fee.label} disabled={!editable} placeholder={fee.kind === "delivery" ? "Delivery to…" : "Admin fee"} onChange={(event) => updateFee(fee.key, { label: event.target.value })} />
                              </div>
                              <div>
                                <label className="label" htmlFor={`${fee.key}-amount`}>Amount (R)</label>
                                <input id={`${fee.key}-amount`} className="input tabular-nums" inputMode="decimal" value={fee.amount} disabled={!editable} onChange={(event) => updateFee(fee.key, { amount: event.target.value })} />
                              </div>
                              {editable && (
                                <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-red-300" onClick={() => removeFee(fee.key)} aria-label="Remove fee"><Trash2 /></Button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </div>

                  <aside className="space-y-4 lg:sticky lg:top-0 lg:self-start">
                    <section className="rounded-2xl border border-primary/20 bg-primary/[0.055] p-5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Quote total</p>
                      <div className="mt-4 space-y-2 text-sm">
                        <div className="flex justify-between gap-3 text-muted-foreground"><span>Subtotal (excl. VAT)</span><span className="tabular-nums">{rands(calculated.subtotal)}</span></div>
                        <div className="flex justify-between gap-3 text-muted-foreground"><span>VAT</span><span className="tabular-nums">{rands(calculated.vat)}</span></div>
                        {calculated.fees > 0 && <div className="flex justify-between gap-3 text-muted-foreground"><span>Fees &amp; delivery</span><span className="tabular-nums">{rands(calculated.fees)}</span></div>}
                        {/* Internal only, and only when a cost basis exists —
                            without one the margin is trivially 100%. */}
                        {calculated.hasCost && <div className="flex justify-between gap-3 text-muted-foreground"><span>Margin<span className="ml-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">internal</span></span><span className="tabular-nums">{rands(calculated.margin)} · {calculated.marginPct}%</span></div>}
                        <div className="mt-3 flex justify-between gap-3 border-t border-primary/15 pt-3 text-lg font-semibold"><span>Total</span><span className="tabular-nums text-primary">{rands(calculated.total)}</span></div>
                        {calculated.deposit > 0 && (
                          <>
                            <div className="flex justify-between gap-3 text-muted-foreground"><span>Deposit</span><span className="tabular-nums">{rands(calculated.deposit)}</span></div>
                            <div className="flex justify-between gap-3 text-muted-foreground"><span>Balance on delivery</span><span className="tabular-nums">{rands(calculated.balance)}</span></div>
                          </>
                        )}
                      </div>
                    </section>

                    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5">
                      <p className="text-sm font-semibold">Quote settings</p>
                      <div className="mt-4 space-y-4">
                        <div>
                          <label className="label" htmlFor="quote-valid-until">Valid until</label>
                          <input id="quote-valid-until" type="date" className="input" value={draft.validUntil} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, validUntil: event.target.value }))} />
                        </div>
                        <div>
                          <label className="label" htmlFor="quote-tax-basis">Pricing basis</label>
                          <select id="quote-tax-basis" className="input" value={draft.taxInclusive ? "true" : "false"} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, taxInclusive: event.target.value === "true" }))}>
                            <option value="true">Prices include VAT</option>
                            <option value="false">Add VAT on top</option>
                          </select>
                        </div>
                        <div>
                          <label className="label" htmlFor="quote-deposit-type">Deposit</label>
                          <div className="flex gap-2">
                            <select id="quote-deposit-type" className="input" value={draft.depositType} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, depositType: event.target.value as DraftState["depositType"] }))}>
                              <option value="">None</option>
                              <option value="percent">Percent</option>
                              <option value="amount">Amount</option>
                            </select>
                            {draft.depositType && (
                              <input className="input w-24 tabular-nums" inputMode="decimal" placeholder={draft.depositType === "percent" ? "%" : "R"} value={draft.depositValue} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, depositValue: event.target.value }))} aria-label="Deposit value" />
                            )}
                          </div>
                        </div>
                        <div>
                          <label className="label" htmlFor="quote-terms">Terms</label>
                          <textarea id="quote-terms" className="input min-h-32 resize-y" value={draft.terms} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, terms: event.target.value }))} />
                        </div>
                      </div>
                    </section>

                    {/*
                      The workspace's own fields for a quote. They had no
                      surface here at all, so anything a business had added —
                      finance house, fleet number, PO reference — was invisible
                      and uneditable from the screen where quotes are built.
                      Saved on their own, by the same action the record page
                      used; the draft above is unaffected by that save.
                    */}
                    {savedQuote && customFields.length > 0 && (
                      <CustomFieldsForm
                        fields={customFields}
                        action={saveCustomFieldValues.bind(null, "quote", savedQuote.id)}
                        readOnly={!editable}
                        className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5"
                      />
                    )}
                  </aside>
                </div>
              </TabsContent>

              <TabsContent value="preview" className="h-full overflow-y-auto bg-[#090b0a] p-4 sm:p-7">
                <div className="mx-auto min-h-[42rem] max-w-4xl rounded-sm bg-white px-6 py-8 text-slate-900 shadow-[0_24px_80px_rgba(0,0,0,.45)] sm:px-12 sm:py-12">
                  <div className="flex items-start justify-between gap-6 border-b-2 border-orange-500 pb-7">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.24em] text-orange-600">Denago Cape Town EV</p>
                      <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Customer proposal</h2>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-bold text-orange-600">{savedQuote ? `Q-${savedQuote.number}` : "DRAFT"}</p>
                      <p className="mt-1 text-xs text-slate-500">Valid until {displayDate(draft.validUntil)}</p>
                    </div>
                  </div>
                  <div className="grid gap-6 py-8 sm:grid-cols-2">
                    <div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Prepared for</p><p className="mt-2 text-lg font-semibold">{customerLabel}</p></div>
                    <div className="sm:text-right"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Quote status</p><p className="mt-2 font-medium capitalize">{currentStatus}</p></div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] border-collapse text-sm">
                      <thead><tr className="border-y border-slate-200 text-left text-[10px] uppercase tracking-[0.12em] text-slate-500"><th className="py-3">Description</th><th className="py-3 text-right">Qty</th><th className="py-3 text-right">Unit price</th><th className="py-3 text-right">Disc</th><th className="py-3 text-right">Total</th></tr></thead>
                      <tbody>
                        {draft.lines.map((line) => {
                          const qty = Number(line.qty.replace(",", ".")) || 0;
                          const price = centsFromInput(line.unitPrice) || 0;
                          const discount = Math.min(100, Math.max(0, Number(line.discount.replace(",", ".")) || 0));
                          const lineTotal = Math.round(qty * price * (1 - discount / 100));
                          // The customer's document drops a declined add-on
                          // entirely — printing it would show a charge that
                          // isn't in the total.
                          if (line.optional && !line.selected) return null;
                          return <tr key={line.key} className="border-b border-slate-100"><td className="py-4 pr-4"><span className="block">{line.description || "Untitled line"}</span>{line.colorPreference && <span className="mt-1 block text-xs text-slate-500">Colour preference: {line.colorPreference}</span>}</td><td className="py-4 text-right tabular-nums">{qty}</td><td className="py-4 text-right tabular-nums">{rands(price)}</td><td className="py-4 text-right tabular-nums text-slate-500">{discount ? `${discount}%` : "—"}</td><td className="py-4 text-right font-medium tabular-nums">{rands(lineTotal)}</td></tr>;
                        })}
                        {calculated.feeLines.map((fee) => (
                          <tr key={fee.description} className="border-b border-slate-100"><td className="py-4 pr-4">{fee.description}</td><td className="py-4 text-right tabular-nums">{fee.qty}</td><td className="py-4 text-right tabular-nums">{rands(fee.unitPriceCents)}</td><td className="py-4 text-right tabular-nums text-slate-500">—</td><td className="py-4 text-right font-medium tabular-nums">{rands(fee.unitPriceCents)}</td></tr>
                        ))}
                        {draft.lines.length === 0 && calculated.feeLines.length === 0 && <tr><td colSpan={5} className="py-12 text-center text-slate-400">No line items added.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="ml-auto mt-8 w-full max-w-xs space-y-2 text-sm">
                    {/* "VAT included" was printed in both tax modes — on a
                        tax-exclusive quote the rows above are ex-VAT, so it
                        stated the opposite of what the customer would pay. */}
                    <div className="flex justify-between text-slate-500"><span>{draft.taxInclusive ? "Subtotal (excl. VAT)" : "Subtotal"}</span><span>{rands(calculated.subtotal)}</span></div>
                    <div className="flex justify-between text-slate-500"><span>{draft.taxInclusive ? "VAT included" : "VAT"}</span><span>{rands(calculated.vat)}</span></div>
                    <div className="flex justify-between border-t-2 border-slate-900 pt-3 text-lg font-bold"><span>Total incl. VAT</span><span>{rands(calculated.total)}</span></div>
                  </div>
                  {draft.terms && <div className="mt-12 border-t border-slate-200 pt-6"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">Terms</p><p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">{draft.terms}</p></div>}
                </div>
              </TabsContent>

              <TabsContent value="versions" className="h-full overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-3xl">
                  <div className="mb-5"><h3 className="text-lg font-semibold tracking-tight">Version history</h3><p className="mt-1 text-sm text-muted-foreground">Every version shown to a customer remains on record and cannot be silently overwritten.</p></div>
                  {!record || record.versions.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/[0.1] px-6 py-14 text-center"><FileClock className="mx-auto size-8 text-muted-foreground" /><p className="mt-4 font-medium">This is the first draft</p><p className="mt-1 text-sm text-muted-foreground">Version history starts when a sent or declined quote is revised.</p></div>
                  ) : (
                    <div className="space-y-2">
                      {record.versions.map((version) => (
                        <div key={version.id} className={cn("flex items-center gap-4 rounded-2xl border p-4", version.current ? "border-primary/30 bg-primary/[0.06]" : "border-white/[0.08] bg-white/[0.025]")}>
                          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/[0.08] bg-black/20 text-sm font-semibold">Q</span>
                          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><p className="font-semibold">Q-{version.number}</p>{version.current && <StatusPill tone="info">Current</StatusPill>}<StatusPill tone={statusTone(version.status)}>{version.superseded ? "superseded" : version.status}</StatusPill></div><p className="mt-1 text-xs text-muted-foreground">Created {version.createdAt}</p></div>
                          {version.current ? (
                            <span className="shrink-0 px-3 text-xs text-muted-foreground">Open here</span>
                          ) : onOpenQuote ? (
                            <Button type="button" variant="ghost" size="sm" onClick={() => requestOpenVersion(version.id)}>Open</Button>
                          ) : (
                            <Button asChild variant="ghost" size="sm"><Link href={`/quotes/${version.id}`}>Open <ExternalLink /></Link></Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="send" className="h-full overflow-y-auto p-4 sm:p-6">
                <div className="mx-auto max-w-3xl space-y-5">
                  {error && <FeedbackBanner tone="danger" title="Quote not ready">{error}</FeedbackBanner>}
                  <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 sm:p-6">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                      <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Ready to send</p><h3 className="mt-2 text-xl font-semibold tracking-tight">Review the final total and record the hand-off</h3><p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Marking a quote sent freezes this version. Further changes require a revision, protecting the exact price the customer received.</p></div>
                      <StatusPill tone={statusTone(currentStatus)}>{currentStatus}</StatusPill>
                    </div>
                    <div className="mt-6 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-xl border border-white/[0.07] bg-black/15 p-4"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Customer</p><p className="mt-2 truncate text-sm font-semibold">{customerLabel}</p></div>
                      <div className="rounded-xl border border-white/[0.07] bg-black/15 p-4"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Line items</p><p className="mt-2 text-sm font-semibold">{draft.lines.length}</p></div>
                      <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4"><p className="text-[10px] uppercase tracking-wider text-primary">Total incl. VAT</p><p className="mt-2 text-sm font-semibold text-primary">{rands(calculated.total)}</p></div>
                    </div>
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                      {editable ? (
                        <>
                          <Button type="button" onClick={() => save("sent")} disabled={isPending}><Send />{isPending ? "Saving…" : "Save & mark sent"}</Button>
                          {/*
                            Saves as a DRAFT and drops you on the signature card
                            below. Freezing is left to the dispatch, which marks
                            the quote sent the moment the customer's link
                            actually goes out — so getting as far as the
                            countersign pad and stopping doesn't cost a revision.
                          */}
                          <Button type="button" variant="outline" onClick={() => save("draft", { thenSign: true })} disabled={isPending}><PenLine />Send for signature</Button>
                        </>
                      ) : (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole className="size-4" />{signing?.locked ? "Out for signature — void the request below to edit." : "This version is already frozen."}</div>
                      )}
                      {/*
                        The record page calls this destination "Print / PDF" —
                        the printable document, with the browser's own
                        print-to-PDF. Calling it "Open PDF preview" here made it
                        read as a different, lesser thing, so the button people
                        were looking for seemed to be missing from the tab whose
                        job is sending the quote out.
                      */}
                      {savedQuote && <Button asChild variant="outline"><a href={`/quotes/${savedQuote.id}/print`} target="_blank" rel="noreferrer"><Printer />Print / PDF</a></Button>}
                      {/*
                        Was "Signing & delivery", which promised a screen that
                        does not exist — it is the same destination as "Open
                        full record" at the bottom of the dialog, and "delivery"
                        there meant delivery FEES, which that page only itemises.
                        One destination, one name.
                      */}
                      {savedQuote && <Button asChild variant="ghost"><Link href={`/quotes/${savedQuote.id}`}>Open full record <ExternalLink /></Link></Button>}
                    </div>

                  </section>

                  {/*
                    The signature card, in the tab that sends the quote. It used
                    to live only on the full record, so countersigning and
                    sending the secure link meant leaving a half-finished quote
                    for a different screen. Same component, same server actions
                    — it just refetches through onChanged, because a route
                    refresh cannot reach props inside a dialog.
                  */}
                  {!savedQuote ? (
                    <FeedbackBanner tone="info" title="Save the quote to send it for signature">
                      The signature card appears here the moment the quote exists — countersign, send the secure link and watch it land, without leaving the editor.
                    </FeedbackBanner>
                  ) : signing ? (
                    <SigningBlock
                      kind="quote"
                      id={savedQuote.id}
                      refLabel={`Q-${savedQuote.number}`}
                      signedAt={signing.signedAt}
                      signedByName={signing.signedByName}
                      signedPdfHash={signing.signedPdfHash}
                      dealerSignedAt={signing.dealerSignedAt}
                      dealerSignedByName={signing.dealerSignedByName}
                      hasSavedSignature={signing.hasSavedSignature}
                      state={signing.state}
                      workflows={signing.workflows}
                      onChanged={reloadSigning}
                    />
                  ) : signingReady ? (
                    <FeedbackBanner tone="info" title="This version can't be signed from here">
                      It may have been superseded by a revision, or your role may not include sending quotes for signature. The full record shows where it stands.
                    </FeedbackBanner>
                  ) : (
                    <div className="flex items-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.025] px-5 py-6 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />Checking signature status…
                    </div>
                  )}
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-white/[0.08] bg-[#101411] px-4 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              {record?.createdAt && <span className="truncate">Created {record.createdAt}</span>}
              {savedQuote && <Link href={`/quotes/${savedQuote.id}`} className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">Open full record <ExternalLink className="size-3" /></Link>}
              {/*
                The same ConfirmDelete and the same deleteQuote action as the
                record page and the list, so the reason field is required here
                too and the server-side rules — quotes.delete on THIS quote,
                voiding a live signing request, reopening the lead behind an
                accepted quote — hold identically. Bound to the action rather
                than reimplemented, so they cannot drift apart.

                onOpenChange, not requestOpenChange: the discard prompt asks
                about saving edits to a quote that no longer exists.
              */}
              {savedQuote && (
                <ConfirmDelete
                  action={deleteQuote.bind(null, savedQuote.id)}
                  title={`Delete quote Q-${savedQuote.number}?`}
                  description={deleteConsequences}
                  trigger="Delete quote"
                  triggerClass="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-red-400"
                  confirmLabel="Delete quote"
                  success={`Quote Q-${savedQuote.number} moved to Trash`}
                  contentClassName="z-[110]"
                  onDeleted={() => onOpenChange(false)}
                  disabled={!canDelete}
                  disabledReason="Your role can't delete quotes."
                />
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={() => requestOpenChange(false)}>Close</Button>
              {editable && <Button type="button" className="flex-1 sm:flex-none" onClick={() => save("draft")} disabled={isPending || !dirty}><Save />{isPending ? "Saving…" : savedQuote ? "Save changes" : "Save draft"}</Button>}
            </div>
          </footer>
        </ResponsiveDialogContent>
      </Dialog>

      {/* Dismissing the prompt must also forget where it was heading, or a
          later Close would switch versions instead of closing. */}
      <Dialog open={discardOpen} onOpenChange={(next) => { setDiscardOpen(next); if (!next) setPendingVersionId(null); }}>
        <ResponsiveDialogContent className="z-[110] sm:max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              {pendingVersionId
                ? "Your latest quote edits have not been saved. Opening another version leaves them behind."
                : "Your latest quote edits have not been saved."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => { setDiscardOpen(false); setPendingVersionId(null); }}>Keep editing</Button>
            <Button type="button" variant="destructive" onClick={discardAndClose}>{pendingVersionId ? "Discard and open" : "Discard changes"}</Button>
          </div>
        </ResponsiveDialogContent>
      </Dialog>
    </>
  );
}

type QuoteEditorContextValue = {
  openEditor: (quoteId?: string, initialContactId?: string) => void;
};

const QuoteEditorContext = createContext<QuoteEditorContextValue | null>(null);

export function QuoteEditorProvider({
  children,
  contacts,
  leads,
  products,
  defaults,
  records,
  initialQuoteId,
}: {
  children: ReactNode;
  contacts: QuoteEditorContact[];
  leads: QuoteEditorLead[];
  products: QuoteEditorProduct[];
  defaults: QuoteEditorDefaults;
  records: QuoteEditorRecord[];
  initialQuoteId?: string;
}) {
  const [selection, setSelection] = useState<{ quoteId?: string; initialContactId?: string } | null>(
    initialQuoteId ? { quoteId: initialQuoteId } : null,
  );
  /**
   * `records` is what the PAGE rendered — the newest 200 quotes at the time it
   * loaded. Anything else has to be fetched: a revision has an id that did not
   * exist when the page rendered, and a deep link can name a quote older than
   * the cap. Both used to open the editor completely blank, because a missing
   * record is indistinguishable from "new quote".
   */
  const [fetched, setFetched] = useState<QuoteEditorRecord | null>(null);
  const listed = selection?.quoteId ? records.find((item) => item.id === selection.quoteId) ?? null : null;
  const record = listed ?? (fetched && fetched.id === selection?.quoteId ? fetched : null);
  const awaitingRecord = Boolean(selection?.quoteId) && !record;

  useEffect(() => {
    const quoteId = selection?.quoteId;
    if (!quoteId || listed) return;
    let live = true;
    quoteEditorRecord(quoteId).then((loaded) => {
      if (live && loaded) setFetched(loaded);
    });
    return () => {
      live = false;
    };
  }, [selection?.quoteId, listed]);

  return (
    <QuoteEditorContext.Provider value={{ openEditor: (quoteId, initialContactId) => setSelection({ quoteId, initialContactId }) }}>
      {children}
      {/* Not until the record is in hand: the draft is built ONCE, at mount,
          so mounting early against a null record produces an empty quote that
          no later arrival can fix. */}
      {selection && !awaitingRecord && (
        <QuoteEditorDialog
          // Remount when the target quote changes: the draft is built from
          // `record` once, on mount, so swapping to a revision without this
          // would show the previous quote's lines against the new record.
          key={selection.quoteId ?? "new"}
          open
          onOpenChange={(next) => !next && setSelection(null)}
          contacts={contacts}
          leads={leads}
          products={products}
          defaults={defaults}
          record={record}
          initialContactId={selection.initialContactId}
          onOpenQuote={(quoteId) => setSelection({ quoteId })}
        />
      )}
    </QuoteEditorContext.Provider>
  );
}

export function QuoteEditorTrigger({
  children,
  quoteId,
  initialContactId,
  className,
}: {
  children: ReactNode;
  quoteId?: string;
  initialContactId?: string;
  className?: string;
}) {
  const context = useContext(QuoteEditorContext);
  if (!context) throw new Error("QuoteEditorTrigger must be used inside QuoteEditorProvider.");
  return (
    <button type="button" onClick={() => context.openEditor(quoteId, initialContactId)} className={className}>
      {children}
    </button>
  );
}
