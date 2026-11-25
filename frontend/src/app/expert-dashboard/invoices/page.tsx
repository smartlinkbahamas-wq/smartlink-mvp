"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Copy, Download, Loader2, Plus, Receipt, Send, Trash2, X } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listInvoices,
  sendInvoice,
  cancelInvoice,
  recordPayment,
  deletePayment,
  downloadInvoicePdf,
  formatMoney,
} from "@/lib/business-hub-api";
import type { Invoice } from "@/types";

/**
 * Invoices.
 *
 * Created from an approved quotation on the Quotations screen -- there is no
 * "new invoice" button here, because invoicing something the customer never
 * agreed to is the one path that causes real disputes.
 *
 * Paid / part paid / overdue is computed by the server from the payment rows
 * and the due date. Nothing on this screen sets a payment status directly.
 */

const STATUS_STYLES: Record<string, string> = {
  Paid: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  "Partially Paid": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  Unpaid: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  Overdue: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function InvoicesPage() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sentLink, setSentLink] = useState<{ url: string; delivered: boolean } | null>(null);

  const [paymentFor, setPaymentFor] = useState<Invoice | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [paymentReference, setPaymentReference] = useState("");
  const [savingPayment, setSavingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState("");

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
        const rows = await listInvoices(token);
        if (active) setInvoices(rows);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your invoices.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  function requireToken() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return null;
    }
    return token;
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

  const handleSend = (invoice: Invoice) =>
    run(invoice.id, async () => {
      const token = requireToken();
      if (!token) return;
      const result = await sendInvoice(invoice.id, token);
      setInvoices((rows) => rows.map((row) => (row.id === invoice.id ? result.data.invoice : row)));
      setNotice(result.message);
      setSentLink({ url: result.data.customerUrl, delivered: result.data.delivered });
    });

  const handleCancel = (invoice: Invoice) =>
    run(invoice.id, async () => {
      const reason = window.prompt(`Why are you cancelling ${invoice.reference}?`);
      if (reason === null) return;
      const token = requireToken();
      if (!token) return;
      const updated = await cancelInvoice(invoice.id, reason, token);
      setInvoices((rows) => rows.map((row) => (row.id === invoice.id ? updated : row)));
      setNotice(`${updated.reference} cancelled.`);
    });

  function openPayment(invoice: Invoice) {
    setPaymentFor(invoice);
    // Prefilled with the outstanding balance, which is the common case.
    setPaymentAmount(invoice.balance > 0 ? String(invoice.balance) : "");
    setPaymentMethod("");
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setPaymentReference("");
    setPaymentError("");
  }

  async function savePayment() {
    if (!paymentFor) return;
    const token = requireToken();
    if (!token) return;

    setSavingPayment(true);
    setPaymentError("");

    try {
      const updated = await recordPayment(
        paymentFor.id,
        {
          amount: Number(paymentAmount),
          paidOn: paymentDate || undefined,
          method: paymentMethod.trim() || undefined,
          reference: paymentReference.trim() || undefined,
        },
        token,
      );
      setInvoices((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setNotice(
        `Payment recorded. ${updated.reference} is now ${updated.displayStatus.toLowerCase()}${
          updated.balance > 0 ? ` with ${formatMoney(updated.balance)} outstanding` : ""
        }.`,
      );
      setPaymentFor(null);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Could not record that payment.");
    } finally {
      setSavingPayment(false);
    }
  }

  const handleDeletePayment = (invoice: Invoice, paymentId: string) =>
    run(invoice.id, async () => {
      if (!window.confirm("Remove this payment? Only do this if it was entered in error.")) return;
      const token = requireToken();
      if (!token) return;
      const updated = await deletePayment(invoice.id, paymentId, token);
      setInvoices((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setNotice("Payment removed.");
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
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <Receipt className="h-6 w-6 text-blue-600" aria-hidden="true" />
          Invoices
        </h1>
        <p className="mt-1 text-gray-500">
          Created from approved quotations. Payment is arranged directly with your customer —
          SmartLink does not collect it.
        </p>
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
            {sentLink.delivered ? "The customer's invoice link:" : "The email failed. Send this link instead:"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded bg-white px-2 py-1 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">{sentLink.url}</code>
            <button type="button" onClick={() => navigator.clipboard?.writeText(sentLink.url)} className="inline-flex items-center gap-1 rounded-lg border border-blue-300 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-300">
              <Copy className="h-3 w-3" aria-hidden="true" />Copy
            </button>
            <button type="button" onClick={() => setSentLink(null)} className="text-xs underline text-blue-700 dark:text-blue-300">Hide</button>
          </div>
        </div>
      ) : null}

      {invoices.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">No invoices yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Once a customer approves a quotation, use &quot;Create invoice&quot; on that quotation to
            raise one without re-entering anything.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {invoices.map((invoice) => {
            const busy = busyId === invoice.id;
            const cancelled = invoice.status === "cancelled";

            return (
              <li key={invoice.id} className={`rounded-xl border bg-white p-5 dark:bg-gray-800 ${cancelled ? "border-dashed border-gray-300 opacity-70 dark:border-gray-600" : "border-gray-100 dark:border-gray-700"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-white">{invoice.job_name}</h3>
                      {cancelled ? (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">Cancelled</span>
                      ) : (
                        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[invoice.displayStatus] || STATUS_STYLES.Unpaid}`}>
                          {invoice.displayStatus}
                        </span>
                      )}
                      {invoice.status === "draft" ? (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">Draft</span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      {invoice.reference}
                      {invoice.quotation_reference ? ` · from ${invoice.quotation_reference}` : ""} ·{" "}
                      {invoice.customer_name}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      Issued {formatDate(invoice.issue_date)} · Due {formatDate(invoice.due_date)}
                      {invoice.isOverdue ? " · past due" : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900 dark:text-white">
                      {formatMoney(invoice.balance, invoice.currency)}
                    </p>
                    <p className="text-xs text-gray-500">
                      outstanding of {formatMoney(invoice.total, invoice.currency)}
                    </p>
                  </div>
                </div>

                {invoice.payments?.length > 0 ? (
                  <div className="mt-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-700/40">
                    <p className="text-xs font-semibold uppercase text-gray-500">Payments received</p>
                    <ul className="mt-1 space-y-1">
                      {invoice.payments.map((payment) => (
                        <li key={payment.id} className="flex items-center justify-between gap-2 text-xs text-gray-700 dark:text-gray-300">
                          <span>
                            {formatDate(payment.paid_on)}
                            {payment.method ? ` · ${payment.method}` : ""}
                            {payment.reference ? ` · ${payment.reference}` : ""}
                          </span>
                          <span className="flex items-center gap-2">
                            <strong>{formatMoney(payment.amount, invoice.currency)}</strong>
                            <button
                              type="button"
                              onClick={() => handleDeletePayment(invoice, payment.id)}
                              disabled={busy}
                              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-900/20"
                              aria-label="Remove this payment"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-700">
                  {!cancelled ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleSend(invoice)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                        {invoice.status === "draft" ? "Send to customer" : "Send again"}
                      </button>
                      {invoice.paymentStatus !== "paid" ? (
                        <button
                          type="button"
                          onClick={() => openPayment(invoice)}
                          disabled={busy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                        >
                          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                          Record a payment
                        </button>
                      ) : null}
                    </>
                  ) : null}

                  <button
                    type="button"
                    onClick={() =>
                      run(invoice.id, async () => {
                        const token = requireToken();
                        if (token) await downloadInvoicePdf(invoice.id, invoice.reference, token);
                      })
                    }
                    disabled={busy}
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    PDF
                  </button>

                  {!cancelled && invoice.paid === 0 ? (
                    <button
                      type="button"
                      onClick={() => handleCancel(invoice)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-900/20"
                    >
                      <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                      Cancel
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {paymentFor ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="payment-title"
          onClick={() => !savingPayment && setPaymentFor(null)}
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="payment-title" className="text-lg font-semibold text-gray-900 dark:text-white">Record a payment</h2>
                <p className="mt-1 text-sm text-gray-500">
                  {paymentFor.reference} · {formatMoney(paymentFor.balance, paymentFor.currency)} outstanding
                </p>
              </div>
              <button type="button" onClick={() => setPaymentFor(null)} disabled={savingPayment} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {paymentError ? (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                {paymentError}
              </div>
            ) : null}

            <div className="space-y-3">
              <div>
                <label htmlFor="p-amount" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Amount received</label>
                <input id="p-amount" inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value.replace(/[^\d.]/g, ""))} className={inputClass} />
              </div>
              <div>
                <label htmlFor="p-date" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Date received</label>
                <input id="p-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="p-method" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">How <span className="font-normal text-gray-500">(optional)</span></label>
                <input id="p-method" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} placeholder="Cash, bank transfer, cheque" className={inputClass} />
              </div>
              <div>
                <label htmlFor="p-ref" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Your reference <span className="font-normal text-gray-500">(optional)</span></label>
                <input id="p-ref" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} className={inputClass} />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setPaymentFor(null)} disabled={savingPayment} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                type="button"
                onClick={savePayment}
                disabled={savingPayment || !paymentAmount || Number(paymentAmount) <= 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingPayment ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Record payment
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
