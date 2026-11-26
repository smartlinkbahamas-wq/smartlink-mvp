"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LifeBuoy, Loader2, Plus, Send, ShieldAlert, X } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listMyTickets,
  getMyTicket,
  createSupportTicket,
  postTicketMessage,
  requestOriginalComplaint,
} from "@/lib/business-hub-api";
import type { ProviderTicket, TicketMessage } from "@/types";

/**
 * Support and complaints, as a provider sees them.
 *
 * For a complaint, this screen shows the administrator's SUMMARY, never the
 * customer's original words — those are not even sent to the browser. The
 * provider may ask to see the original; an administrator decides.
 *
 * The screen says so plainly rather than leaving a provider to wonder what is
 * being withheld, and it states the two policy positions that protect them:
 * an unverified complaint does not affect their standing, and SmartLink
 * documents disputes rather than adjudicating them.
 */

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  under_review: "Under review",
  awaiting_customer: "Awaiting the customer",
  awaiting_provider: "Awaiting you",
  resolved: "Resolved",
  closed: "Closed",
};

const STATUS_STYLES: Record<string, string> = {
  new: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  under_review: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  awaiting_customer: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  awaiting_provider: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  resolved: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  closed: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
};

function formatWhen(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export default function ProviderSupportPage() {
  const router = useRouter();
  const [tickets, setTickets] = useState<ProviderTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    ticket: ProviderTicket;
    messages: TicketMessage[];
    originalComplaint: string | null;
  } | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState({ subject: "", body: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

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
        const rows = await listMyTickets(token);
        if (active) setTickets(rows);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your tickets.");
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

  async function open(ticket: ProviderTicket) {
    if (openId === ticket.id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    const token = requireToken();
    if (!token) return;

    setOpenId(ticket.id);
    setDetail(null);
    setReply("");
    setError("");

    try {
      setDetail(await getMyTicket(ticket.id, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that ticket.");
    }
  }

  async function sendReply() {
    if (!openId || !reply.trim()) return;
    const token = requireToken();
    if (!token) return;

    setBusy(true);
    setError("");
    try {
      await postTicketMessage(openId, reply.trim(), token);
      setDetail(await getMyTicket(openId, token));
      setReply("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that message.");
    } finally {
      setBusy(false);
    }
  }

  async function askForOriginal() {
    if (!openId) return;
    const token = requireToken();
    if (!token) return;

    setBusy(true);
    setError("");
    try {
      const result = await requestOriginalComplaint(openId, token);
      setNotice(result.message);
      setDetail(await getMyTicket(openId, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send that request.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setFormError("");
    try {
      const result = await createSupportTicket(
        { subject: form.subject.trim(), body: form.body.trim() },
        token,
      );
      setTickets((rows) => [result.data, ...rows]);
      setNotice(result.message);
      setNewOpen(false);
      setForm({ subject: "", body: "" });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not raise that ticket.");
    } finally {
      setSaving(false);
    }
  }

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
            <LifeBuoy className="h-6 w-6 text-blue-600" aria-hidden="true" />
            Help &amp; Support
          </h1>
          <p className="mt-1 text-gray-500">
            Ask us for help, and see any concerns a customer has raised about your work.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setForm({ subject: "", body: "" });
            setFormError("");
            setNewOpen(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Ask for help
        </button>
      </div>

      {/* The two policy positions, stated where they matter rather than buried
          in terms nobody reads. */}
      <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
        <div>
          <p className="font-semibold text-gray-900 dark:text-white">How complaints work here</p>
          <p className="mt-1">
            An administrator reviews a complaint before you see it, and sends you a summary rather
            than the customer&apos;s original message. You can ask to see the original. An unverified
            complaint does not count against you, and SmartLink records disputes without taking a
            side on workmanship or refunds.
          </p>
        </div>
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

      {tickets.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">Nothing open</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            If you need help with the platform, raise a ticket. If a customer raises a concern about
            your work, it will appear here once an administrator has reviewed it.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {tickets.map((ticket) => {
            const isOpen = openId === ticket.id;
            const isComplaint = ticket.category === "job_complaint";

            return (
              <li key={ticket.id} className="rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-white">{ticket.subject}</h3>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[ticket.status]}`}>
                        {STATUS_LABELS[ticket.status]}
                      </span>
                      {isComplaint ? (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                          Customer concern
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      {ticket.reference} · raised {formatWhen(ticket.created_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => open(ticket)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {isOpen ? "Close" : "Open"}
                  </button>
                </div>

                {isOpen ? (
                  <div className="mt-4 space-y-4 border-t border-gray-100 pt-4 dark:border-gray-700">
                    {detail === null ? (
                      <p className="text-sm text-gray-500">Loading…</p>
                    ) : (
                      <>
                        {isComplaint && detail.ticket.provider_summary ? (
                          <div className="rounded-xl bg-amber-50 p-4 dark:bg-amber-900/20">
                            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                              Summary from the administrator
                            </p>
                            <p className="mt-1 text-sm text-amber-900 dark:text-amber-200">
                              {detail.ticket.provider_summary}
                            </p>
                          </div>
                        ) : null}

                        {/* Shown only once an administrator shared it. Until
                            then the text is not sent to this page at all. */}
                        {detail.originalComplaint ? (
                          <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-600 dark:bg-gray-900">
                            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                              The customer&apos;s original message
                            </p>
                            <p className="mt-1 whitespace-pre-line text-sm text-gray-900 dark:text-white">
                              {detail.originalComplaint}
                            </p>
                          </div>
                        ) : isComplaint ? (
                          <div className="rounded-xl border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-400">
                            {detail.ticket.original_requested_at ? (
                              <>You have asked to see the customer&apos;s original message. An administrator is reviewing that request.</>
                            ) : (
                              <>
                                You are seeing the administrator&apos;s summary rather than the
                                customer&apos;s own words.{" "}
                                <button
                                  type="button"
                                  onClick={askForOriginal}
                                  disabled={busy}
                                  className="font-semibold text-blue-600 underline disabled:opacity-50"
                                >
                                  Ask to see the original
                                </button>
                              </>
                            )}
                          </div>
                        ) : null}

                        <div className="space-y-2">
                          {detail.messages.length === 0 ? (
                            <p className="text-sm text-gray-500">No messages yet.</p>
                          ) : (
                            detail.messages.map((message) => (
                              <div
                                key={message.id}
                                className={`rounded-lg p-3 text-sm ${
                                  message.author_type === "provider"
                                    ? "ml-8 bg-blue-50 dark:bg-blue-900/20"
                                    : "mr-8 bg-gray-50 dark:bg-gray-700/40"
                                }`}
                              >
                                <p className="text-xs font-semibold text-gray-500">
                                  {message.author_type === "provider" ? "You" : "SmartLink"} ·{" "}
                                  {formatWhen(message.created_at)}
                                </p>
                                <p className="mt-1 whitespace-pre-line text-gray-900 dark:text-white">
                                  {message.body}
                                </p>
                              </div>
                            ))
                          )}
                        </div>

                        {detail.ticket.resolution ? (
                          <div className="rounded-xl bg-green-50 p-4 dark:bg-green-900/20">
                            <p className="text-xs font-semibold uppercase tracking-wide text-green-800 dark:text-green-300">
                              Outcome
                            </p>
                            <p className="mt-1 text-sm text-green-900 dark:text-green-200">
                              {detail.ticket.resolution}
                            </p>
                          </div>
                        ) : null}

                        {!["resolved", "closed"].includes(detail.ticket.status) ? (
                          <div className="flex flex-wrap items-end gap-2">
                            <label className="sr-only" htmlFor={`reply-${ticket.id}`}>Your reply</label>
                            <textarea
                              id={`reply-${ticket.id}`}
                              rows={2}
                              value={reply}
                              onChange={(e) => setReply(e.target.value)}
                              placeholder="Reply to the administrator handling this"
                              className={`${inputClass} min-w-[16rem] flex-1`}
                            />
                            <button
                              type="button"
                              onClick={sendReply}
                              disabled={busy || !reply.trim()}
                              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                              Send
                            </button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {newOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10" role="dialog" aria-modal="true" aria-labelledby="ticket-title" onClick={() => !saving && setNewOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="ticket-title" className="text-lg font-semibold text-gray-900 dark:text-white">Ask for help</h2>
                <p className="mt-1 text-sm text-gray-500">
                  For problems with the platform itself. For a dispute about a specific job, an
                  administrator will contact you.
                </p>
              </div>
              <button type="button" onClick={() => setNewOpen(false)} disabled={saving} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                {formError}
              </div>
            ) : null}

            <div className="space-y-3">
              <div>
                <label htmlFor="t-subject" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">What is it about?</label>
                <input id="t-subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="I cannot send a quotation" className={inputClass} />
              </div>
              <div>
                <label htmlFor="t-body" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">What happened?</label>
                <textarea id="t-body" rows={5} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className={inputClass} />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setNewOpen(false)} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
              <button type="button" onClick={handleCreate} disabled={saving || !form.subject.trim() || !form.body.trim()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Send
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
