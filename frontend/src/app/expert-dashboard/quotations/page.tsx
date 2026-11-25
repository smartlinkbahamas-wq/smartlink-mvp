"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock,
  Copy,
  Download,
  FileText,
  Loader2,
  Plus,
  Receipt,
  Send,
  Trash2,
  X,
} from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listQuotations,
  createQuotation,
  updateQuotation,
  sendQuotation,
  extendQuotationValidity,
  reviseQuotation,
  deleteQuotation,
  downloadQuotationPdf,
  createInvoiceFromQuotation,
  createJobFromQuotation,
  formatMoney,
} from "@/lib/business-hub-api";
import type { DocumentLineItem, Quotation, QuotationInput } from "@/types";

/**
 * Quotations.
 *
 * The calculation order is fixed and mirrored here for live feedback:
 *   Subtotal -> Discount (%) -> Tax (%) -> Additional costs -> Total
 * The server recomputes all of it on save; these figures are a preview.
 *
 * An approved quotation is read-only. Editing one would change the price the
 * customer agreed to behind their approval, so the only route is a revision
 * with its own number.
 */

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  sent: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  approved: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  declined: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  changes_requested: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  expired: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  superseded: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Awaiting customer",
  approved: "Approved",
  declined: "Declined",
  changes_requested: "Changes requested",
  expired: "Expired",
  superseded: "Superseded",
};

interface Draft {
  id: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  jobName: string;
  customerSummary: string;
  terms: string;
  lineItems: DocumentLineItem[];
  discountPercent: string;
  discountAmount: string;
  discountReason: string;
  taxRatePercent: string;
  taxLabel: string;
  additionalCosts: string;
  additionalCostsLabel: string;
  validityDays: string;
}

const EMPTY: Draft = {
  id: null,
  customerName: "",
  customerEmail: "",
  customerPhone: "",
  jobName: "",
  customerSummary: "",
  terms: "",
  lineItems: [{ label: "", quantity: 1, unitPrice: 0 }],
  discountPercent: "",
  discountAmount: "",
  discountReason: "",
  taxRatePercent: "",
  taxLabel: "VAT",
  additionalCosts: "",
  additionalCostsLabel: "Delivery and setup",
  validityDays: "30",
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const round2 = (value: number) => Math.round(value * 100) / 100;
const digits = (value: string) => value.replace(/[^\d.]/g, "");

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function QuotationsPage() {
  const router = useRouter();
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [sentLink, setSentLink] = useState<{ url: string; delivered: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const session = await getSessionMe();
        if (!active) return;
        if (!canUseExpertSection(session.role)) {
          router.replace("/login");
          return;
        }
        const token = getAdminAccessToken();
        if (!token) {
          router.replace("/login");
          return;
        }
        const rows = await listQuotations(token);
        if (active) setQuotations(rows);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your quotations.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  const totals = useMemo(() => {
    const priced = draft.lineItems.filter((item) => !item.informational);
    const subtotal = round2(
      priced.reduce((sum, item) => sum + round2(num(item.quantity) * num(item.unitPrice)), 0),
    );
    // Percentage first, then the fixed amount off what remains, and never more
    // than the subtotal.
    const percentOff = round2((subtotal * num(draft.discountPercent)) / 100);
    const discountTotal = Math.min(round2(percentOff + num(draft.discountAmount)), subtotal);
    const taxable = round2(subtotal - discountTotal);
    const tax = round2((taxable * num(draft.taxRatePercent)) / 100);
    const additional = num(draft.additionalCosts);
    return {
      subtotal,
      discountTotal,
      taxable,
      tax,
      additional,
      total: round2(taxable + tax + additional),
    };
  }, [draft]);

  function requireToken() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return null;
    }
    return token;
  }

  function openNew() {
    setDraft(EMPTY);
    setFormError("");
    setEditorOpen(true);
  }

  function openEdit(quotation: Quotation) {
    setDraft({
      id: quotation.id,
      customerName: quotation.customer_name,
      customerEmail: quotation.customer_email,
      customerPhone: quotation.customer_phone || "",
      jobName: quotation.job_name,
      customerSummary: quotation.customer_summary || "",
      terms: quotation.terms || "",
      lineItems: quotation.line_items?.length ? quotation.line_items : EMPTY.lineItems,
      discountPercent: quotation.discount_percent ? String(quotation.discount_percent) : "",
      discountAmount: quotation.discount_amount ? String(quotation.discount_amount) : "",
      discountReason: quotation.discount_reason || "",
      taxRatePercent: quotation.tax_rate_percent ? String(quotation.tax_rate_percent) : "",
      taxLabel: quotation.tax_label || "VAT",
      additionalCosts: quotation.additional_costs ? String(quotation.additional_costs) : "",
      additionalCostsLabel: quotation.additional_costs_label || "Delivery and setup",
      validityDays: String(quotation.validity_days || 30),
    });
    setFormError("");
    setEditorOpen(true);
  }

  function patchLine(index: number, patch: Partial<DocumentLineItem>) {
    setDraft((current) => ({
      ...current,
      lineItems: current.lineItems.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  }

  function buildPayload(): QuotationInput {
    return {
      customerName: draft.customerName.trim(),
      customerEmail: draft.customerEmail.trim(),
      customerPhone: draft.customerPhone.trim() || undefined,
      jobName: draft.jobName.trim(),
      customerSummary: draft.customerSummary.trim() || undefined,
      terms: draft.terms.trim() || undefined,
      lineItems: draft.lineItems
        .filter((item) => item.label?.trim())
        .map((item) =>
          item.informational
            ? { label: item.label!.trim(), informational: true, value: item.value?.trim() || "" }
            : {
                label: item.label!.trim(),
                description: item.description?.trim() || undefined,
                quantity: num(item.quantity),
                unitPrice: num(item.unitPrice),
              },
        ),
      discountPercent: num(draft.discountPercent),
      discountAmount: num(draft.discountAmount),
      discountReason: draft.discountReason.trim() || undefined,
      taxRatePercent: num(draft.taxRatePercent),
      taxLabel: draft.taxLabel.trim() || undefined,
      additionalCosts: num(draft.additionalCosts),
      additionalCostsLabel: draft.additionalCostsLabel.trim() || undefined,
      validityDays: num(draft.validityDays) || 30,
    };
  }

  async function handleSave() {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setFormError("");

    try {
      const payload = buildPayload();
      if (draft.id) {
        const saved = await updateQuotation(draft.id, payload, token);
        setQuotations((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
        setNotice(`${saved.reference} saved.`);
      } else {
        const saved = await createQuotation(payload, token);
        setQuotations((rows) => [saved, ...rows]);
        setNotice(`${saved.reference} created as a draft.`);
      }
      setEditorOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save that quotation.");
    } finally {
      setSaving(false);
    }
  }

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action could not be completed.");
    } finally {
      setBusyId(null);
    }
  }

  const handleSend = (quotation: Quotation) =>
    run(quotation.id, async () => {
      const token = requireToken();
      if (!token) return;
      const result = await sendQuotation(quotation.id, token);
      setQuotations((rows) =>
        rows.map((row) => (row.id === quotation.id ? result.data.quotation : row)),
      );
      setNotice(result.message);
      // Surfaced whether or not the email went out, so a provider whose mail
      // failed can still get the quotation to the customer.
      setSentLink({ url: result.data.customerUrl, delivered: result.data.delivered });
    });

  const handleExtend = (quotation: Quotation, days: number) =>
    run(quotation.id, async () => {
      const token = requireToken();
      if (!token) return;
      const updated = await extendQuotationValidity(quotation.id, days, token);
      setQuotations((rows) => rows.map((row) => (row.id === quotation.id ? updated : row)));
      setNotice(`${updated.reference} is now valid until ${formatDate(updated.valid_until)}.`);
    });

  const handleRevise = (quotation: Quotation) =>
    run(quotation.id, async () => {
      const token = requireToken();
      if (!token) return;
      const revision = await reviseQuotation(quotation.id, token);
      const rows = await listQuotations(token);
      setQuotations(rows);
      setNotice(`${revision.reference} created as a draft revision of ${quotation.reference}.`);
    });

  const handleDelete = (quotation: Quotation) =>
    run(quotation.id, async () => {
      if (!window.confirm(`Delete draft ${quotation.reference}?`)) return;
      const token = requireToken();
      if (!token) return;
      await deleteQuotation(quotation.id, token);
      setQuotations((rows) => rows.filter((row) => row.id !== quotation.id));
      setNotice("Draft deleted.");
    });

  const handleInvoice = (quotation: Quotation) =>
    run(quotation.id, async () => {
      const token = requireToken();
      if (!token) return;
      const invoice = await createInvoiceFromQuotation(quotation.id, { dueInDays: 14 }, token);
      setNotice(`Draft invoice ${invoice.reference} created. Open Invoices to send it.`);
    });

  const handleJob = (quotation: Quotation) =>
    run(quotation.id, async () => {
      const token = requireToken();
      if (!token) return;
      const job = await createJobFromQuotation(quotation.id, null, token);
      setNotice(`Job ${job.reference} created from ${quotation.reference}.`);
    });

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 p-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <FileText className="h-6 w-6 text-blue-600" aria-hidden="true" />
            Quotations
          </h1>
          <p className="mt-1 text-gray-500">Build a quotation and send it for the customer to approve.</p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New quotation
        </button>
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {notice && !error ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="underline">Dismiss</button>
        </div>
      ) : null}

      {sentLink ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900/50 dark:bg-blue-900/20">
          <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
            {sentLink.delivered
              ? "The customer's approval link (keep this if they say it did not arrive):"
              : "The email could not be delivered. Send the customer this link instead:"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
              {sentLink.url}
            </code>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(sentLink.url)}
              className="inline-flex items-center gap-1 rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-300"
            >
              <Copy className="h-3 w-3" aria-hidden="true" />
              Copy
            </button>
            <button type="button" onClick={() => setSentLink(null)} className="text-xs underline text-blue-700 dark:text-blue-300">
              Hide
            </button>
          </div>
          <p className="mt-2 text-xs text-blue-800 dark:text-blue-300">
            The customer also needs the 6-digit code emailed to them. For security it is not shown
            here — use &quot;resend code&quot; on their page if it did not arrive.
          </p>
        </div>
      ) : null}

      {quotations.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">No quotations yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Build one from scratch, or price a job in the cost calculator first and bring the figure
            across.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {quotations.map((quotation) => {
            const status = quotation.effective_status;
            const busy = busyId === quotation.id;

            return (
              <li
                key={quotation.id}
                className="rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-white">{quotation.job_name}</h3>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] || STATUS_STYLES.draft}`}>
                        {STATUS_LABELS[status] || status}
                      </span>
                      {quotation.version > 1 ? (
                        <span className="text-xs text-gray-500">version {quotation.version}</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      {quotation.reference} · {quotation.customer_name} · {quotation.customer_email}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      {quotation.sent_at ? `Sent ${formatDate(quotation.sent_at)} · ` : ""}
                      {quotation.valid_until
                        ? `${quotation.is_expired ? "Expired" : "Valid until"} ${formatDate(quotation.valid_until)}`
                        : `Valid for ${quotation.validity_days} days once sent`}
                    </p>
                    {quotation.customer_message ? (
                      <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
                        Customer said: {quotation.customer_message}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {formatMoney(quotation.total, quotation.currency)}
                    </p>
                    {Number(quotation.discount_total) > 0 ? (
                      <p className="text-xs text-gray-500">
                        after {formatMoney(quotation.discount_total)} discount
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-700">
                  {!quotation.is_locked ? (
                    <button
                      type="button"
                      onClick={() => openEdit(quotation)}
                      disabled={busy}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Edit
                    </button>
                  ) : null}

                  {["draft", "sent", "changes_requested", "expired", "declined"].includes(status) ? (
                    <button
                      type="button"
                      onClick={() => handleSend(quotation)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      {quotation.sent_at ? "Send again" : "Send to customer"}
                    </button>
                  ) : null}

                  {status === "sent" ? (
                    <button
                      type="button"
                      onClick={() => handleExtend(quotation, 7)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                      Extend 7 days
                    </button>
                  ) : null}

                  {["approved", "superseded"].includes(quotation.status) || quotation.is_expired ? (
                    <button
                      type="button"
                      onClick={() => handleRevise(quotation)}
                      disabled={busy}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Create revision
                    </button>
                  ) : null}

                  {quotation.status === "approved" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleInvoice(quotation)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        <Receipt className="h-3.5 w-3.5" aria-hidden="true" />
                        Create invoice
                      </button>
                      <button
                        type="button"
                        onClick={() => handleJob(quotation)}
                        disabled={busy}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        Create job
                      </button>
                    </>
                  ) : null}

                  <button
                    type="button"
                    onClick={() =>
                      run(quotation.id, async () => {
                        const token = requireToken();
                        if (token) await downloadQuotationPdf(quotation.id, quotation.reference, token);
                      })
                    }
                    disabled={busy}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    PDF
                  </button>

                  {quotation.status === "draft" ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(quotation)}
                      disabled={busy}
                      className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20"
                      aria-label={`Delete ${quotation.reference}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editorOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10"
          role="dialog"
          aria-modal="true"
          aria-labelledby="quotation-editor-title"
          onClick={() => !saving && setEditorOpen(false)}
        >
          <div
            className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between gap-4">
              <h2 id="quotation-editor-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                {draft.id ? "Edit quotation" : "New quotation"}
              </h2>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                disabled={saving}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                {formError}
              </div>
            ) : null}

            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="q-customer" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Customer name</label>
                  <input id="q-customer" value={draft.customerName} onChange={(e) => setDraft({ ...draft, customerName: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="q-email" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Email</label>
                  <input id="q-email" type="email" value={draft.customerEmail} onChange={(e) => setDraft({ ...draft, customerEmail: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="q-phone" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Phone <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="q-phone" value={draft.customerPhone} onChange={(e) => setDraft({ ...draft, customerPhone: e.target.value })} className={inputClass} />
                </div>
              </div>

              <div>
                <label htmlFor="q-job" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Job name</label>
                <input id="q-job" value={draft.jobName} onChange={(e) => setDraft({ ...draft, jobName: e.target.value })} className={inputClass} />
              </div>

              <div>
                <label htmlFor="q-summary" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Summary <span className="font-normal text-gray-500">(optional)</span></label>
                <textarea id="q-summary" rows={2} value={draft.customerSummary} onChange={(e) => setDraft({ ...draft, customerSummary: e.target.value })} className={inputClass} />
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">Lines</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, lineItems: [...draft.lineItems, { label: "", quantity: 1, unitPrice: 0 }] })}
                      className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <Plus className="mr-1 inline h-3 w-3" aria-hidden="true" />Charge
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, lineItems: [...draft.lineItems, { label: "", informational: true, value: "" }] })}
                      className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <Plus className="mr-1 inline h-3 w-3" aria-hidden="true" />Information only
                    </button>
                  </div>
                </div>
                <p className="mb-2 text-xs text-gray-500">
                  An information-only line records something about the job — an event date, preferred
                  colours, a site note — without affecting the price.
                </p>

                <div className="space-y-2">
                  {draft.lineItems.map((item, index) => (
                    <div key={index} className="flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-2 dark:bg-gray-700/40">
                      <input
                        value={item.label || ""}
                        onChange={(e) => patchLine(index, { label: e.target.value })}
                        placeholder={item.informational ? "Event date" : "Description"}
                        className="min-w-[8rem] flex-1 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                        aria-label={`Line ${index + 1} label`}
                      />
                      {item.informational ? (
                        <input
                          value={item.value || ""}
                          onChange={(e) => patchLine(index, { value: e.target.value })}
                          placeholder="14 February 2027"
                          className="min-w-[8rem] flex-1 rounded-lg border border-gray-300 p-2 text-sm italic dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                          aria-label={`Line ${index + 1} value`}
                        />
                      ) : (
                        <>
                          <input
                            inputMode="decimal"
                            value={String(item.quantity ?? 1)}
                            onChange={(e) => patchLine(index, { quantity: num(digits(e.target.value)) })}
                            className="w-20 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                            aria-label={`Line ${index + 1} quantity`}
                            placeholder="Qty"
                          />
                          <input
                            inputMode="decimal"
                            value={String(item.unitPrice ?? 0)}
                            onChange={(e) => patchLine(index, { unitPrice: num(digits(e.target.value)) })}
                            className="w-28 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                            aria-label={`Line ${index + 1} unit price`}
                            placeholder="Unit price"
                          />
                          <span className="w-24 text-right text-sm font-semibold text-gray-900 dark:text-white">
                            {formatMoney(round2(num(item.quantity) * num(item.unitPrice)))}
                          </span>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => setDraft({ ...draft, lineItems: draft.lineItems.filter((_, i) => i !== index) })}
                        className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                        aria-label={`Remove line ${index + 1}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="q-discount-pct" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Discount %</label>
                  <input id="q-discount-pct" inputMode="decimal" value={draft.discountPercent} onChange={(e) => setDraft({ ...draft, discountPercent: digits(e.target.value) })} placeholder="0" className={inputClass} />
                </div>
                <div>
                  <label htmlFor="q-discount-amt" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Discount amount</label>
                  <input id="q-discount-amt" inputMode="decimal" value={draft.discountAmount} onChange={(e) => setDraft({ ...draft, discountAmount: digits(e.target.value) })} placeholder="0.00" className={inputClass} />
                </div>
              </div>

              <div>
                <label htmlFor="q-discount-reason" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Reason for the discount <span className="font-normal text-gray-500">(shown to the customer)</span></label>
                <input id="q-discount-reason" value={draft.discountReason} onChange={(e) => setDraft({ ...draft, discountReason: e.target.value })} placeholder="Repeat customer" className={inputClass} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="q-tax-label" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Tax label</label>
                  <input id="q-tax-label" value={draft.taxLabel} onChange={(e) => setDraft({ ...draft, taxLabel: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="q-tax-rate" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Tax rate %</label>
                  <input id="q-tax-rate" inputMode="decimal" value={draft.taxRatePercent} onChange={(e) => setDraft({ ...draft, taxRatePercent: digits(e.target.value) })} placeholder="0" className={inputClass} />
                  <p className="mt-1 text-xs text-gray-500">
                    Only a VAT-registered business can charge tax. Add your registration in Profile
                    first, or this will be refused.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="q-additional-label" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Additional costs label</label>
                  <input id="q-additional-label" value={draft.additionalCostsLabel} onChange={(e) => setDraft({ ...draft, additionalCostsLabel: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="q-additional" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Additional costs</label>
                  <input id="q-additional" inputMode="decimal" value={draft.additionalCosts} onChange={(e) => setDraft({ ...draft, additionalCosts: digits(e.target.value) })} placeholder="0.00" className={inputClass} />
                </div>
              </div>

              <div>
                <label htmlFor="q-validity" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Valid for (days)</label>
                <input id="q-validity" inputMode="numeric" value={draft.validityDays} onChange={(e) => setDraft({ ...draft, validityDays: e.target.value.replace(/\D/g, "") })} className={inputClass} />
                <p className="mt-1 text-xs text-gray-500">
                  30 days by default. Shorter is allowed — 1, 3 or 7 days for fast-moving work.
                  Validity does not reserve an appointment slot.
                </p>
              </div>

              <div>
                <label htmlFor="q-terms" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Terms <span className="font-normal text-gray-500">(optional)</span></label>
                <textarea id="q-terms" rows={3} value={draft.terms} onChange={(e) => setDraft({ ...draft, terms: e.target.value })} placeholder="50% deposit required to confirm. Balance due on completion." className={inputClass} />
              </div>

              <dl className="space-y-1.5 rounded-xl bg-gray-50 p-4 text-sm dark:bg-gray-700/40">
                <div className="flex justify-between"><dt className="text-gray-600 dark:text-gray-400">Subtotal</dt><dd className="font-medium text-gray-900 dark:text-white">{formatMoney(totals.subtotal)}</dd></div>
                {totals.discountTotal > 0 ? (
                  <div className="flex justify-between"><dt className="text-gray-600 dark:text-gray-400">Discount</dt><dd className="font-medium text-gray-900 dark:text-white">−{formatMoney(totals.discountTotal)}</dd></div>
                ) : null}
                {num(draft.taxRatePercent) > 0 ? (
                  <div className="flex justify-between"><dt className="text-gray-600 dark:text-gray-400">{draft.taxLabel || "Tax"} ({num(draft.taxRatePercent)}% of {formatMoney(totals.taxable)})</dt><dd className="font-medium text-gray-900 dark:text-white">{formatMoney(totals.tax)}</dd></div>
                ) : null}
                {totals.additional > 0 ? (
                  <div className="flex justify-between"><dt className="text-gray-600 dark:text-gray-400">{draft.additionalCostsLabel}</dt><dd className="font-medium text-gray-900 dark:text-white">{formatMoney(totals.additional)}</dd></div>
                ) : null}
                <div className="flex justify-between border-t border-gray-200 pt-2 dark:border-gray-600"><dt className="font-semibold text-gray-900 dark:text-white">Total</dt><dd className="text-lg font-bold text-blue-600">{formatMoney(totals.total)}</dd></div>
              </dl>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setEditorOpen(false)} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !draft.customerName.trim() || !draft.customerEmail.trim() || !draft.jobName.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {draft.id ? "Save changes" : "Create draft"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
