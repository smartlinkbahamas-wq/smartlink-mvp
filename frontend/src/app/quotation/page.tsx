"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, Download, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import {
  fetchCustomerQuotation,
  resendCustomerQuotationCode,
  respondToCustomerQuotation,
  downloadCustomerPdf,
  formatMoney,
} from "@/lib/business-hub-api";
import type { CustomerQuotationView } from "@/types";

/**
 * The customer's quotation page. No account, no sign-in.
 *
 * The token is read from the URL FRAGMENT (#t=...), not the query string.
 * A fragment is never sent to any server and never appears in a Referer
 * header, so a working approval token cannot end up in an access log or be
 * handed to a third-party script on an outbound link.
 */

function readTokenFromFragment() {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  // "?t=" is accepted as a fallback for mail clients that strip fragments, but
  // the links SmartLink sends always use the fragment.
  return params.get("t") || new URLSearchParams(window.location.search).get("t") || "";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export default function CustomerQuotationPage() {
  const [token, setToken] = useState("");
  const [quotation, setQuotation] = useState<CustomerQuotationView | null>(null);
  const [canRespond, setCanRespond] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [decision, setDecision] = useState<"approve" | "decline" | "request_changes" | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [outcome, setOutcome] = useState("");
  const [resendNotice, setResendNotice] = useState("");

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
        const data = await fetchCustomerQuotation(found);
        if (!active) return;
        setQuotation(data.quotation);
        setCanRespond(data.canRespond);
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

  async function handleResend() {
    setResendNotice("");
    setSubmitError("");
    try {
      const result = await resendCustomerQuotationCode(token);
      setResendNotice(result.message);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not send a new code.");
    }
  }

  async function handleSubmit() {
    if (!decision) return;

    setSubmitting(true);
    setSubmitError("");

    try {
      const result = await respondToCustomerQuotation(token, {
        decision,
        code: code.trim(),
        message: message.trim() || undefined,
        acceptedTerms,
      });
      setOutcome(result.message);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not record your response.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <Loader2 className="h-8 w-8 animate-spin text-[#356AF6]" />
      </main>
    );
  }

  if (error || !quotation) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-2xl border border-[#D9E3F3] bg-white p-8 text-center">
          <TriangleAlert className="mx-auto h-10 w-10 text-amber-500" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-[#111827]">We could not open this quotation</h1>
          <p className="mt-2 text-sm text-[#5E6F8A]">{error}</p>
          <p className="mt-4 text-sm text-[#5E6F8A]">
            If you were expecting a quotation, contact the provider who sent it and ask them to
            resend the link.
          </p>
        </div>
      </main>
    );
  }

  if (outcome) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 py-16">
        <div className="w-full max-w-md rounded-2xl border border-[#D9E3F3] bg-white p-8 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-[#111827]">Thank you</h1>
          <p className="mt-2 text-sm text-[#5E6F8A]">{outcome}</p>
          <p className="mt-4 text-xs text-[#8794A8]">
            Quotation {quotation.reference} · {quotation.business?.business_name || "your provider"}
          </p>
        </div>
      </main>
    );
  }

  const business = quotation.business;
  const expired = quotation.status === "expired";

  return (
    <main className="min-h-screen bg-[#F7FAFF] px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        {/* The document itself */}
        <article className="overflow-hidden rounded-2xl border border-[#D9E3F3] bg-white">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[#E6EDF9] p-6">
            <div>
              <h1 className="text-2xl font-bold text-[#111827]">Quotation</h1>
              <p className="mt-1 text-sm text-[#5E6F8A]">
                {quotation.reference}
                {quotation.version > 1 ? ` · version ${quotation.version}` : ""}
              </p>
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
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Prepared for</p>
              <p className="text-lg font-semibold text-[#111827]">{quotation.customerName}</p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Work</p>
              <p className="text-lg font-semibold text-[#111827]">{quotation.jobName}</p>
              {quotation.customerSummary ? (
                <p className="mt-1 text-sm text-[#5E6F8A]">{quotation.customerSummary}</p>
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
                  {quotation.lineItems?.map((item, index) => (
                    <tr key={index} className="border-b border-[#F0F4FC] last:border-0">
                      <td className="py-2.5 pr-3">
                        <span className="font-medium text-[#111827]">{item.label}</span>
                        {item.description ? (
                          <span className="block text-xs text-[#8794A8]">{item.description}</span>
                        ) : null}
                      </td>
                      {item.informational ? (
                        // An information-only line carries no figures at all, so
                        // there is no chance of it reading as a charge.
                        <td colSpan={3} className="py-2.5 text-right text-xs italic text-[#5E6F8A]">
                          {item.value || "Noted"}
                        </td>
                      ) : (
                        <>
                          <td className="py-2.5 text-right text-[#111827]">{item.quantity}</td>
                          <td className="py-2.5 text-right text-[#111827]">
                            {formatMoney(item.unitPrice, quotation.currency)}
                          </td>
                          <td className="py-2.5 text-right font-semibold text-[#111827]">
                            {formatMoney(item.lineTotal, quotation.currency)}
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
                <dd className="font-medium text-[#111827]">{formatMoney(quotation.subtotal, quotation.currency)}</dd>
              </div>
              {quotation.discountTotal > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">
                    Discount{quotation.discountReason ? ` (${quotation.discountReason})` : ""}
                  </dt>
                  <dd className="font-medium text-[#111827]">
                    −{formatMoney(quotation.discountTotal, quotation.currency)}
                  </dd>
                </div>
              ) : null}
              {quotation.taxRatePercent > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">{quotation.taxLabel} ({quotation.taxRatePercent}%)</dt>
                  <dd className="font-medium text-[#111827]">{formatMoney(quotation.taxAmount, quotation.currency)}</dd>
                </div>
              ) : null}
              {quotation.additionalCosts > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-[#5E6F8A]">{quotation.additionalCostsLabel}</dt>
                  <dd className="font-medium text-[#111827]">{formatMoney(quotation.additionalCosts, quotation.currency)}</dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-[#E6EDF9] pt-2">
                <dt className="text-base font-semibold text-[#111827]">Total</dt>
                <dd className="text-lg font-bold text-[#356AF6]">{formatMoney(quotation.total, quotation.currency)}</dd>
              </div>
            </dl>

            {quotation.terms ? (
              <div className="rounded-xl bg-[#F7FAFF] p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#8794A8]">Terms</p>
                <p className="mt-1 whitespace-pre-line text-sm text-[#111827]">{quotation.terms}</p>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E6EDF9] pt-4">
              <p className="text-sm text-[#5E6F8A]">
                {expired ? "This quotation expired on " : "Valid until "}
                <strong className="text-[#111827]">{formatDate(quotation.validUntil)}</strong>
              </p>
              <button
                type="button"
                onClick={() => downloadCustomerPdf("quotation", token, quotation.reference)}
                className="inline-flex items-center gap-2 rounded-xl border border-[#D9E3F3] px-4 py-2 text-sm font-medium text-[#111827] hover:bg-[#F7FAFF]"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Download PDF
              </button>
            </div>
          </div>
        </article>

        {/* The decision */}
        {expired ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            This quotation has expired and can no longer be approved. Contact
            {business?.business_name ? ` ${business.business_name}` : " the provider"} and ask for an
            updated one.
          </div>
        ) : !canRespond ? (
          <div className="rounded-2xl border border-[#D9E3F3] bg-white p-5 text-sm text-[#5E6F8A]">
            This quotation has already been answered. Contact the provider if you need to change
            anything.
          </div>
        ) : (
          <section className="rounded-2xl border border-[#D9E3F3] bg-white p-6">
            <h2 className="text-lg font-semibold text-[#111827]">Your response</h2>
            <p className="mt-1 text-sm text-[#5E6F8A]">
              Choose what you would like to do, then enter the 6-digit code we emailed you.
            </p>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {[
                { value: "approve" as const, label: "Approve", hint: "Accept this quotation" },
                { value: "request_changes" as const, label: "Request changes", hint: "Ask for something different" },
                { value: "decline" as const, label: "Decline", hint: "Not going ahead" },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setDecision(option.value)}
                  className={`rounded-xl border p-3 text-left transition ${
                    decision === option.value
                      ? "border-[#356AF6] bg-[#F2F6FF]"
                      : "border-[#D9E3F3] hover:bg-[#F7FAFF]"
                  }`}
                >
                  <span className="block text-sm font-semibold text-[#111827]">{option.label}</span>
                  <span className="block text-xs text-[#5E6F8A]">{option.hint}</span>
                </button>
              ))}
            </div>

            {decision ? (
              <div className="mt-5 space-y-4">
                {decision === "approve" ? (
                  <label className="flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={acceptedTerms}
                      onChange={(event) => setAcceptedTerms(event.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-[#111827]">
                      I accept this quotation of{" "}
                      <strong>{formatMoney(quotation.total, quotation.currency)}</strong> and its
                      terms.
                    </span>
                  </label>
                ) : null}

                <div>
                  <label htmlFor="customer-message" className="mb-1 block text-sm font-medium text-[#111827]">
                    {decision === "request_changes"
                      ? "What would you like changed?"
                      : "Anything to add? (optional)"}
                  </label>
                  <textarea
                    id="customer-message"
                    rows={3}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    maxLength={2000}
                    className="w-full rounded-xl border border-[#D9E3F3] p-3 text-sm text-[#111827] focus:border-[#356AF6] focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="customer-code" className="mb-1 block text-sm font-medium text-[#111827]">
                    6-digit code from your email
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="customer-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="123456"
                      className="h-11 w-36 rounded-xl border border-[#D9E3F3] px-3 text-sm tracking-[0.3em] text-[#111827] focus:border-[#356AF6] focus:outline-none"
                    />
                    <button type="button" onClick={handleResend} className="text-sm font-medium text-[#356AF6] underline">
                      Send me a new code
                    </button>
                  </div>
                  <p className="mt-2 flex items-start gap-1.5 text-xs text-[#5E6F8A]">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    We ask for this so the provider knows the response came from you.
                  </p>
                </div>

                {resendNotice ? <p className="text-sm text-emerald-700">{resendNotice}</p> : null}
                {submitError ? (
                  <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {submitError}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={
                    submitting || code.length !== 6 || (decision === "approve" && !acceptedTerms)
                  }
                  className="inline-flex items-center gap-2 rounded-xl bg-[#356AF6] px-6 py-3 text-sm font-semibold text-white transition hover:bg-[#2C59D8] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {decision === "approve"
                    ? "Approve this quotation"
                    : decision === "decline"
                      ? "Decline this quotation"
                      : "Send my requested changes"}
                </button>
              </div>
            ) : null}
          </section>
        )}

        <p className="text-center text-xs text-[#8794A8]">
          Payment is arranged directly with {business?.business_name || "the provider"}. SmartLink
          does not take payment.
        </p>
      </div>
    </main>
  );
}
