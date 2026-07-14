"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  Check,
  Clock3,
  ExternalLink,
  Eye,
  FileClock,
  FileText,
  History,
  Loader2,
  LockKeyhole,
  PackageOpen,
  Plus,
  Save,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { saveQuoteDraft, type QuoteDraftInput } from "@/app/actions/quotes";
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

export type QuoteEditorProduct = {
  id: string;
  name: string;
  basePriceCents: number;
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
  leadLabel: string | null;
  validUntil: string;
  terms: string;
  createdAt: string;
  editable: boolean;
  lockedReason: string | null;
  items: Array<{
    id: string;
    description: string;
    qty: number;
    unitPriceCents: number;
  }>;
  versions: QuoteEditorVersion[];
};

export type QuoteEditorDefaults = {
  validUntil: string;
  terms: string;
};

type DraftLine = {
  key: string;
  description: string;
  qty: string;
  unitPrice: string;
};

type DraftState = {
  contactId: string;
  validUntil: string;
  terms: string;
  lines: DraftLine[];
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

function createDraft(record: QuoteEditorRecord | null, defaults: QuoteEditorDefaults, initialContactId?: string) {
  if (!record) {
    return {
      contactId: initialContactId ?? "",
      validUntil: defaults.validUntil,
      terms: defaults.terms,
      lines: [],
    } satisfies DraftState;
  }
  return {
    contactId: record.contactId ?? "",
    validUntil: record.validUntil,
    terms: record.terms,
    lines: record.items.map((item) => ({
      key: item.id,
      description: item.description,
      qty: String(item.qty),
      unitPrice: priceInput(item.unitPriceCents),
    })),
  } satisfies DraftState;
}

function draftSnapshot(draft: DraftState) {
  return JSON.stringify({
    contactId: draft.contactId,
    validUntil: draft.validUntil,
    terms: draft.terms,
    lines: draft.lines.map(({ description, qty, unitPrice }) => ({ description, qty, unitPrice })),
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
  products,
  defaults,
  record = null,
  initialContactId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contacts: QuoteEditorContact[];
  products: QuoteEditorProduct[];
  defaults: QuoteEditorDefaults;
  record?: QuoteEditorRecord | null;
  initialContactId?: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftState>(() => createDraft(record, defaults, initialContactId));
  const [initialSnapshot, setInitialSnapshot] = useState(() => draftSnapshot(draft));
  const [savedQuote, setSavedQuote] = useState<SavedQuote>(
    record ? { id: record.id, number: record.number, status: record.status } : null,
  );
  const [activeTab, setActiveTab] = useState("build");
  const [productSearch, setProductSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const currentSnapshot = useMemo(() => draftSnapshot(draft), [draft]);
  const dirty = currentSnapshot !== initialSnapshot;
  const currentStatus = savedQuote?.status ?? record?.status ?? "draft";
  const editable = (record?.editable ?? true) && currentStatus === "draft";
  const customerLabel = contacts.find((contact) => contact.id === draft.contactId)?.label ?? "Customer not selected";

  const calculated = useMemo(() => {
    const total = draft.lines.reduce((sum, line) => {
      const qty = Number(line.qty.replace(",", "."));
      const cents = centsFromInput(line.unitPrice);
      return sum + (Number.isFinite(qty) && Number.isFinite(cents) ? qty * cents : 0);
    }, 0);
    const vat = Math.round(total * (15 / 115));
    return { total: Math.round(total), vat, subtotal: Math.round(total - vat) };
  }, [draft.lines]);

  const productMatches = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase();
    if (!query) return products.slice(0, 5);
    return products.filter((product) => product.name.toLocaleLowerCase().includes(query)).slice(0, 6);
  }, [productSearch, products]);

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    }));
  }

  function addProduct(product: QuoteEditorProduct) {
    if (!editable) return;
    setDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          key: lineKey(),
          description: product.name,
          qty: "1",
          unitPrice: priceInput(product.basePriceCents),
        },
      ],
    }));
    setProductSearch("");
  }

  function addCustomLine() {
    if (!editable) return;
    setDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        { key: lineKey(), description: "", qty: "1", unitPrice: "0.00" },
      ],
    }));
  }

  function removeLine(key: string) {
    if (!editable) return;
    setDraft((current) => ({ ...current, lines: current.lines.filter((line) => line.key !== key) }));
  }

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen && dirty && !isPending) {
      setDiscardOpen(true);
      return;
    }
    onOpenChange(nextOpen);
  }

  function discardAndClose() {
    setDiscardOpen(false);
    onOpenChange(false);
  }

  function save(intent: "draft" | "sent") {
    setError(null);
    if (!draft.contactId) {
      setError("Select a customer before saving the quote.");
      setActiveTab("build");
      return;
    }

    const items: QuoteDraftInput["items"] = [];
    for (const line of draft.lines) {
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
      items.push({ description, qty, unitPriceCents });
    }

    startTransition(async () => {
      try {
        const result = await saveQuoteDraft({
          id: savedQuote?.id,
          contactId: draft.contactId,
          validUntil: draft.validUntil || null,
          terms: draft.terms,
          intent,
          items,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setSavedQuote(result.quote);
        setInitialSnapshot(currentSnapshot);
        setError(null);
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
                <DialogDescription className="mt-1 truncate">
                  {customerLabel}{record?.leadLabel ? ` · ${record.leadLabel}` : ""}
                </DialogDescription>
              </div>
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
                        {record?.lockedReason ?? "Create a revision from the full quote record to make changes."}
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
                    </section>

                    {editable && (
                      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 sm:p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold">Add from product catalogue</p>
                            <p className="mt-1 text-xs text-muted-foreground">Search a product to add its current base price, or add a custom line.</p>
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={addCustomLine}><Plus />Custom line</Button>
                        </div>
                        <div className="relative mt-4">
                          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                          <input
                            value={productSearch}
                            onChange={(event) => setProductSearch(event.target.value)}
                            className="input pl-9"
                            placeholder="Search products…"
                            aria-label="Search products"
                          />
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {productMatches.map((product) => (
                            <button
                              key={product.id}
                              type="button"
                              onClick={() => addProduct(product)}
                              className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-black/10 px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-primary/[0.06]"
                            >
                              <span className="min-w-0 truncate text-sm font-medium">{product.name}</span>
                              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{rands(product.basePriceCents)}</span>
                            </button>
                          ))}
                          {productMatches.length === 0 && <p className="py-3 text-sm text-muted-foreground">No catalogue products matched.</p>}
                        </div>
                      </section>
                    )}

                    <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025]">
                      <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-4 sm:px-5">
                        <div>
                          <p className="text-sm font-semibold">Line items</p>
                          <p className="mt-1 text-xs text-muted-foreground">{draft.lines.length} {draft.lines.length === 1 ? "line" : "lines"} · prices include VAT</p>
                        </div>
                        {editable && <Button type="button" variant="ghost" size="sm" onClick={addCustomLine}><Plus />Add line</Button>}
                      </div>
                      {draft.lines.length === 0 ? (
                        <div className="px-5 py-12 text-center">
                          <PackageOpen className="mx-auto size-7 text-muted-foreground" />
                          <p className="mt-3 text-sm font-medium">No quote lines yet</p>
                          <p className="mt-1 text-xs text-muted-foreground">Choose a catalogue product or add a custom line.</p>
                        </div>
                      ) : (
                        <div className="divide-y divide-white/[0.07]">
                          {draft.lines.map((line, index) => (
                            <div key={line.key} className="grid gap-3 px-4 py-4 sm:grid-cols-[2rem_minmax(0,1fr)_6rem_9rem_2.25rem] sm:items-end sm:px-5">
                              <span className="hidden pb-2 text-xs font-semibold tabular-nums text-muted-foreground sm:block">{String(index + 1).padStart(2, "0")}</span>
                              <div className="min-w-0">
                                <label className="label" htmlFor={`${line.key}-description`}>Description</label>
                                <input id={`${line.key}-description`} className="input" value={line.description} disabled={!editable} onChange={(event) => updateLine(line.key, { description: event.target.value })} />
                              </div>
                              <div>
                                <label className="label" htmlFor={`${line.key}-qty`}>Qty</label>
                                <input id={`${line.key}-qty`} className="input" inputMode="decimal" value={line.qty} disabled={!editable} onChange={(event) => updateLine(line.key, { qty: event.target.value })} />
                              </div>
                              <div>
                                <label className="label" htmlFor={`${line.key}-price`}>Unit price (R)</label>
                                <input id={`${line.key}-price`} className="input" inputMode="decimal" value={line.unitPrice} disabled={!editable} onChange={(event) => updateLine(line.key, { unitPrice: event.target.value })} />
                              </div>
                              {editable && (
                                <Button type="button" variant="ghost" size="icon" className="text-muted-foreground hover:text-red-300" onClick={() => removeLine(line.key)} aria-label={`Remove line ${index + 1}`}>
                                  <Trash2 />
                                </Button>
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
                        <div className="flex justify-between gap-3 text-muted-foreground"><span>Subtotal</span><span className="tabular-nums">{rands(calculated.subtotal)}</span></div>
                        <div className="flex justify-between gap-3 text-muted-foreground"><span>VAT included</span><span className="tabular-nums">{rands(calculated.vat)}</span></div>
                        <div className="mt-3 flex justify-between gap-3 border-t border-primary/15 pt-3 text-lg font-semibold"><span>Total</span><span className="tabular-nums text-primary">{rands(calculated.total)}</span></div>
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
                          <label className="label" htmlFor="quote-terms">Terms</label>
                          <textarea id="quote-terms" className="input min-h-32 resize-y" value={draft.terms} disabled={!editable} onChange={(event) => setDraft((current) => ({ ...current, terms: event.target.value }))} />
                        </div>
                      </div>
                    </section>
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
                      <thead><tr className="border-y border-slate-200 text-left text-[10px] uppercase tracking-[0.12em] text-slate-500"><th className="py-3">Description</th><th className="py-3 text-right">Qty</th><th className="py-3 text-right">Unit price</th><th className="py-3 text-right">Total</th></tr></thead>
                      <tbody>
                        {draft.lines.map((line) => {
                          const qty = Number(line.qty.replace(",", ".")) || 0;
                          const price = centsFromInput(line.unitPrice) || 0;
                          return <tr key={line.key} className="border-b border-slate-100"><td className="py-4 pr-4">{line.description || "Untitled line"}</td><td className="py-4 text-right tabular-nums">{qty}</td><td className="py-4 text-right tabular-nums">{rands(price)}</td><td className="py-4 text-right font-medium tabular-nums">{rands(Math.round(qty * price))}</td></tr>;
                        })}
                        {draft.lines.length === 0 && <tr><td colSpan={4} className="py-12 text-center text-slate-400">No line items added.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="ml-auto mt-8 w-full max-w-xs space-y-2 text-sm">
                    <div className="flex justify-between text-slate-500"><span>Subtotal</span><span>{rands(calculated.subtotal)}</span></div>
                    <div className="flex justify-between text-slate-500"><span>VAT included</span><span>{rands(calculated.vat)}</span></div>
                    <div className="flex justify-between border-t-2 border-slate-900 pt-3 text-lg font-bold"><span>Total</span><span>{rands(calculated.total)}</span></div>
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
                          <Button asChild variant="ghost" size="sm"><Link href={`/quotes/${version.id}`}>Open <ExternalLink /></Link></Button>
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
                    <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                      {editable ? <Button type="button" onClick={() => save("sent")} disabled={isPending}><Send />{isPending ? "Saving…" : "Save & mark sent"}</Button> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole className="size-4" />This version is already frozen.</div>}
                      {savedQuote && <Button asChild variant="outline"><a href={`/quotes/${savedQuote.id}/print`} target="_blank" rel="noreferrer"><Eye />Open PDF preview</a></Button>}
                      {savedQuote && <Button asChild variant="ghost"><Link href={`/quotes/${savedQuote.id}`}>Signing & delivery <ExternalLink /></Link></Button>}
                    </div>
                  </section>
                  <FeedbackBanner tone="info" title="Secure customer signatures stay protected">
                    Generate and manage the secure signing link from the full quote record after saving. The editor never bypasses signing locks or overwrites a customer-facing version.
                  </FeedbackBanner>
                </div>
              </TabsContent>
            </div>
          </Tabs>

          <footer className="flex shrink-0 flex-col-reverse gap-3 border-t border-white/[0.08] bg-[#101411] px-4 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
              {record?.createdAt && <span className="truncate">Created {record.createdAt}</span>}
              {savedQuote && <Link href={`/quotes/${savedQuote.id}`} className="inline-flex shrink-0 items-center gap-1 text-primary hover:underline">Open full record <ExternalLink className="size-3" /></Link>}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={() => requestOpenChange(false)}>Close</Button>
              {editable && <Button type="button" className="flex-1 sm:flex-none" onClick={() => save("draft")} disabled={isPending || !dirty}><Save />{isPending ? "Saving…" : savedQuote ? "Save changes" : "Save draft"}</Button>}
            </div>
          </footer>
        </ResponsiveDialogContent>
      </Dialog>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <ResponsiveDialogContent className="sm:max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>Your latest quote edits have not been saved.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setDiscardOpen(false)}>Keep editing</Button>
            <Button type="button" variant="destructive" onClick={discardAndClose}>Discard changes</Button>
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
  products,
  defaults,
  records,
  initialQuoteId,
}: {
  children: ReactNode;
  contacts: QuoteEditorContact[];
  products: QuoteEditorProduct[];
  defaults: QuoteEditorDefaults;
  records: QuoteEditorRecord[];
  initialQuoteId?: string;
}) {
  const [selection, setSelection] = useState<{ quoteId?: string; initialContactId?: string } | null>(
    initialQuoteId ? { quoteId: initialQuoteId } : null,
  );
  const record = selection?.quoteId ? records.find((item) => item.id === selection.quoteId) ?? null : null;

  return (
    <QuoteEditorContext.Provider value={{ openEditor: (quoteId, initialContactId) => setSelection({ quoteId, initialContactId }) }}>
      {children}
      {selection && (
        <QuoteEditorDialog
          open
          onOpenChange={(next) => !next && setSelection(null)}
          contacts={contacts}
          products={products}
          defaults={defaults}
          record={record}
          initialContactId={selection.initialContactId}
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
