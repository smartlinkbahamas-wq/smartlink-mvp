"use client";

import React, { useEffect, useState } from "react";
import { Download, Loader2, TriangleAlert } from "lucide-react";

import { fetchCustomerInvoice, downloadCustomerPdf, formatMoney } from "@/lib/business-hub-api";
import type { CustomerInvoiceView } from "@/types";

/**
 * The customer's invoice page. Read-only.
 *
 * No verification code: viewing discloses only what the customer was already
 * sent, and there is no action behind it to protect. The link alone is enough.
 *
 * The token comes from the URL fragment for the same reason as the quotation
 * page -- a fragment never reaches a server log or a Referer header.
 */

function readTokenFromFragment() {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  return params.get("t") || new URLSearchParams(window.location.search).get("t") || "";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function CustomerInvoicePage() {
  const [token, setToken] = useState("");
  const [invoice, setInvoice] = useState<CustomerInvoiceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const found = readTokenFromFragment();
    setToken(found);

    if (!found) {
      setError("This link is incomplete. Please open the link from your email again.");
      setLoading(false);
      return;
    }

    let active = true;
    (async () => {
      try {
        const data = await fetchCustomerInvoice(found);
        if (active) setInvoice(data);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "This link is no longer valid.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Loader2 className="h-8 w-8 animate-spin text-[#356AF6]" />
      </main>
    );
  }

  if (error || !invoice) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-2xl border border-[#D9E3F3] bg-white p-8 text-center">
          <TriangleAlert className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-[#111827]">We could not open this invoice</h1>
          <p className="mt-2 text-sm text-[#5E6F8A]">{error}</p>
        </div>
      </main>
    );
  }

  const business = invoice.business;

  return (
    <main className="min-h-screen bg-[#F7FAFF] px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <article className="overflow-hidden rounded-2xl border border-[#D9E3F3] bg-white">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E6EDF9] p-6">
            <div>
              <h1 className="text-2xl font-bold text-[#111827]">Invoice</h1>
              <p className="mt-1 text-sm text-[#5E6F8A]">
                {invoice.reference}
                {invoice.quotationReference ? ` · from quotation ${invoice.quotationReference}` : ""}
              </p>
              <span
                className={`mt-2 inline-block rounded px-2 py-0.5 text-xs font-semibold ${
                  invoice.isOverdue
                    ? "bg-rose-100 text-rose-700"
                    : invoice.paymentStatus === "Paid"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-[#EEF3FF] text-[#2759C9]"
                }`}
              >
                {invoice.paymentStatus}
              </span>
            </div>
            {business ? (
              <div className="text-right text-sm">
                <p className="font-semibold text-[#111827]">{business.business_name}</p>
                {business.address ? <p className="text-[#5E6F8A]">{business.address}</p> : null}
                {business.phone ? <p className="text-[#5E6F8A]">{business.phone}</p> : null}
                {business.email ? <p className="text-[#5E6F8A]">{business.email}</p> : null}
                {business.vat_registered && business.vat_number ? (
                  <p className="text-[#5E6F8A]">VAT No. {business.vat_number}</p>
                ) : null}
              </div>
            ) : null}
          </header>

          <div className="space-y-5 p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Billed to</p>
                <p className="text-lg font-semibold text-[#111827]">{invoice.customerName}</p>
              </div>
              <div className="sm:text-right">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Dates</p>
                <p className="text-sm text-[#111827]">Issued {formatDate(invoice.issueDate)}</p>
                <p className="text-sm text-[#111827]">Due {formatDate(invoice.dueDate)}</p>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Work</p>
              <p className="text-lg font-semibold text-[#111827]">{invoice.jobName}</p>
              {invoice.customerSummary ? (
                <p className="mt-1 text-sm text-[#5E6F8A]">{invoice.customerSummary}</p>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E6EDF9] text-left text-xs font-semibold uppercase tracking-wide text-[#8794A8]">
                    <th className="pb-2">Description</th>
                    <th className="pb-2 text-right">Qty</th>
                    <th className="pb-2 text-right">Unit</th>
                    <th className="pb-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems?.map((item, index) => (
                    <tr key={index} className="border-b border-[#F0F4FC] last:border-0">
                      <td className="py-2.5 pr-3">
                        <span className="font-medium text-[#111827]">{item.label}</span>
                        {item.description ? (
                          <span className="block text-xs text-[#8794A8]">{item.description}</span>
                        ) : null}
                      </td>
                      {item.informational ? (
                        <td colSpan={3} className="py-2.5 text-right text-xs italic text-[#5E6F8A]">
                          {item.value || "Noted"}
                        </td>
                      ) : (
                        <>
                          <td className="py-2.5 text-right text-[#111827]">{item.quantity}</td>
                          <td className="py-2.5 text-right text-[#111827]">
                            {formatMoney(item.unitPrice, invoice.currency)}
                          </td>
                          <td className="py-2.5 text-right font-semibold text-[#111827]">
                            {formatMoney(item.lineTotal, invoice.currency)}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="ml-auto max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-[#5E6F8A]">Subtotal</dt>
                <dd className="font-medium text-[#111827]">{formatMoney(invoice.subtotal, invoice.currency)}</dd>
              </div>
              {invoice.discountTotal > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">
                    Discount{invoice.discountReason ? ` (${invoice.discountReason})` : ""}
                  </dt>
                  <dd className="font-medium text-[#111827]">−{formatMoney(invoice.discountTotal, invoice.currency)}</dd>
                </div>
              ) : null}
              {invoice.taxRatePercent > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">{invoice.taxLabel} ({invoice.taxRatePercent}%)</dt>
                  <dd className="font-medium text-[#111827]">{formatMoney(invoice.taxAmount, invoice.currency)}</dd>
                </div>
              ) : null}
              {invoice.additionalCosts > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">{invoice.additionalCostsLabel}</dt>
                  <dd className="font-medium text-[#111827]">{formatMoney(invoice.additionalCosts, invoice.currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-[#E6EDF9] pt-2">
                <dt className="font-semibold text-[#111827]">Total</dt>
                <dd className="font-bold text-[#111827]">{formatMoney(invoice.total, invoice.currency)}</dd>
              </div>
              {invoice.amountPaid > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">Paid to date</dt>
                  <dd className="font-medium text-[#111827]">−{formatMoney(invoice.amountPaid, invoice.currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-[#E6EDF9] pt-2">
                <dt className="text-base font-semibold text-[#111827]">Balance due</dt>
                <dd className="text-lg font-bold text-[#356AF6]">
                  {formatMoney(invoice.balanceDue, invoice.currency)}
                </dd>
              </div>
            </dl>

            {invoice.paymentHistory?.length > 0 ? (
              <div className="rounded-xl bg-[#F7FAFF] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Payments received</p>
                <ul className="mt-2 space-y-1 text-sm text-[#111827]">
                  {invoice.paymentHistory.map((payment, index) => (
                    <li key={index} className="flex justify-between">
                      <span>
                        {formatDate(payment.paidOn)}
                        {payment.method ? ` · ${payment.method}` : ""}
                      </span>
                      <strong>{formatMoney(payment.amount, invoice.currency)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {invoice.paymentInstructions || invoice.paymentTerms ? (
              <div className="rounded-xl border border-[#D9E3F3] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">How to pay</p>
                {invoice.paymentTerms ? (
                  <p className="mt-1 text-sm text-[#111827]">{invoice.paymentTerms}</p>
                ) : null}
                {invoice.paymentInstructions ? (
                  <p className="mt-1 whitespace-pre-line text-sm text-[#111827]">
                    {invoice.paymentInstructions}
                  </p>
                ) : null}
              </div>
            ) : null}

            {invoice.terms ? (
              <div className="rounded-xl bg-[#F7FAFF] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Terms</p>
                <p className="mt-1 whitespace-pre-line text-sm text-[#111827]">{invoice.terms}</p>
              </div>
            ) : null}

            <div className="flex justify-end border-t border-[#E6EDF9] pt-4">
              <button
                type="button"
                onClick={() => downloadCustomerPdf("invoice", token, invoice.reference)}
                className="inline-flex items-center gap-2 rounded-xl border border-[#D9E3F3] px-4 py-2 text-sm font-medium text-[#111827] hover:bg-[#F7FAFF]"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Download PDF
              </button>
            </div>
          </div>
        </article>

        <p className="text-center text-xs text-[#8794A8]">
          Pay {business?.business_name || "the provider"} directly using the details above. SmartLink
          does not take payment and cannot collect it on their behalf.
        </p>
      </div>
    </main>
  );
}
