"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArchiveRestore,
  FileText,
  Loader2,
  Mail,
  Phone,
  Plus,
  Receipt,
  Search,
  Users,
  X,
} from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  archiveCustomer,
  formatMoney,
} from "@/lib/business-hub-api";
import type { Customer, CustomerHistory } from "@/types";

/**
 * Customer records.
 *
 * Created automatically when a provider accepts a SmartLink introduction, and
 * added by hand for customers obtained elsewhere, so a provider manages one
 * list rather than two.
 *
 * Only name, email and telephone are collected. The email is the identifier
 * that stops the same person appearing three times.
 */

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function CustomersPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: "", email: "", phone: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [detail, setDetail] = useState<{ customer: Customer; history: CustomerHistory } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let active = true;
    async function run() {
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
        const rows = await listCustomers(token, {
          search: search.trim() || undefined,
          includeArchived: showArchived,
        });
        if (active) setCustomers(rows);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your customers.");
      } finally {
        if (active) setLoading(false);
      }
    }
    run();
    return () => {
      active = false;
    };
    // Re-runs when the search or archive filter changes. Debouncing is not
    // worth it here: a provider's customer list is small and the query is
    // indexed.
  }, [router, search, showArchived]);

  function requireToken() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return null;
    }
    return token;
  }

  function openNew() {
    setEditingId(null);
    setForm({ fullName: "", email: "", phone: "", notes: "" });
    setFormError("");
    setEditorOpen(true);
  }

  function openEdit(customer: Customer) {
    setEditingId(customer.id);
    setForm({
      fullName: customer.full_name,
      email: customer.email || "",
      phone: customer.phone || "",
      notes: customer.notes || "",
    });
    setFormError("");
    setEditorOpen(true);
  }

  async function handleSave() {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setFormError("");

    const payload = {
      fullName: form.fullName.trim(),
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      notes: form.notes.trim() || undefined,
    };

    try {
      if (editingId) {
        const saved = await updateCustomer(editingId, payload, token);
        setCustomers((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
        setNotice(`${saved.full_name} saved.`);
      } else {
        const saved = await createCustomer(payload, token);
        setCustomers((rows) => [...rows, saved].sort((a, b) => a.full_name.localeCompare(b.full_name)));
        setNotice(`${saved.full_name} added.`);
      }
      setEditorOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not save that customer.");
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(customer: Customer) {
    const token = requireToken();
    if (!token) return;

    setBusyId(customer.id);
    setError("");

    try {
      const updated = await archiveCustomer(customer.id, !customer.is_archived, token);
      if (!showArchived && updated.is_archived) {
        setCustomers((rows) => rows.filter((row) => row.id !== customer.id));
      } else {
        setCustomers((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      }
      setNotice(updated.is_archived ? `${updated.full_name} archived.` : `${updated.full_name} restored.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that customer.");
    } finally {
      setBusyId(null);
    }
  }

  async function openDetail(customer: Customer) {
    const token = requireToken();
    if (!token) return;

    setDetailLoading(true);
    setError("");

    try {
      const data = await getCustomer(customer.id, token);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load that customer.");
    } finally {
      setDetailLoading(false);
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
  const labelClass = "mb-1 block text-sm font-medium text-gray-900 dark:text-white";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <Users className="h-6 w-6 text-blue-600" aria-hidden="true" />
            Customers
          </h1>
          <p className="mt-1 text-gray-500">
            Added automatically when you accept an opportunity. You can also add customers who came
            from elsewhere.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a customer
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, email or phone"
            className={`${inputClass} pl-10`}
            aria-label="Search customers"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Show archived
        </label>
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

      {customers.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">
            {search ? "No customers match that search" : "No customers yet"}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            {search
              ? "Try a different name, email or phone number."
              : "A customer record is created the moment you accept an opportunity. You can also add one by hand."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {customers.map((customer) => {
            const busy = busyId === customer.id;

            return (
              <li
                key={customer.id}
                className={`rounded-xl border bg-white p-4 dark:bg-gray-800 ${
                  customer.is_archived
                    ? "border-dashed border-gray-300 opacity-70 dark:border-gray-600"
                    : "border-gray-100 dark:border-gray-700"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-white">{customer.full_name}</h3>
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {customer.source === "smartlink" ? "From SmartLink" : "Your own customer"}
                      </span>
                      {customer.is_archived ? (
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          Archived
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-500">
                      {customer.email ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                          {customer.email}
                        </span>
                      ) : null}
                      {customer.phone ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                          {customer.phone}
                        </span>
                      ) : null}
                      <span className="text-xs">Added {formatDate(customer.created_at)}</span>
                    </div>
                    {customer.notes ? (
                      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{customer.notes}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openDetail(customer)}
                      disabled={busy || detailLoading}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      History
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(customer)}
                      disabled={busy}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleArchive(customer)}
                      disabled={busy}
                      className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:hover:bg-gray-700"
                      aria-label={customer.is_archived ? `Restore ${customer.full_name}` : `Archive ${customer.full_name}`}
                    >
                      {customer.is_archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    </button>
                  </div>
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
          aria-labelledby="customer-editor-title"
          onClick={() => !saving && setEditorOpen(false)}
        >
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <h2 id="customer-editor-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                {editingId ? "Edit customer" : "Add a customer"}
              </h2>
              <button type="button" onClick={() => setEditorOpen(false)} disabled={saving} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                {formError}
              </div>
            ) : null}

            <div className="space-y-4">
              <div>
                <label htmlFor="c-name" className={labelClass}>Name</label>
                <input id="c-name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label htmlFor="c-email" className={labelClass}>
                  Email <span className="font-normal text-gray-500">(optional)</span>
                </label>
                <input id="c-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputClass} />
                <p className="mt-1 text-xs text-gray-500">
                  Used to recognise returning customers, so the same person is not added twice.
                </p>
              </div>
              <div>
                <label htmlFor="c-phone" className={labelClass}>
                  Telephone <span className="font-normal text-gray-500">(optional)</span>
                </label>
                <input id="c-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputClass} />
              </div>
              <div>
                <label htmlFor="c-notes" className={labelClass}>
                  Notes <span className="font-normal text-gray-500">(only you see these)</span>
                </label>
                <textarea id="c-notes" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={inputClass} />
              </div>
            </div>

            {editingId ? (
              <p className="mt-4 rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-700/40 dark:text-gray-300">
                Changing these details does not alter any quotation or invoice already sent — those
                keep the details they were issued with.
              </p>
            ) : null}

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setEditorOpen(false)} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !form.fullName.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {editingId ? "Save changes" : "Add customer"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detail ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10"
          role="dialog"
          aria-modal="true"
          aria-labelledby="customer-detail-title"
          onClick={() => setDetail(null)}
        >
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="customer-detail-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                  {detail.customer.full_name}
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  {detail.customer.email || "No email"}
                  {detail.customer.phone ? ` · ${detail.customer.phone}` : ""}
                </p>
              </div>
              <button type="button" onClick={() => setDetail(null)} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-5">
              <section>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  <FileText className="h-4 w-4" aria-hidden="true" />
                  Quotations ({detail.history.quotations.length})
                </h3>
                {detail.history.quotations.length === 0 ? (
                  <p className="text-sm text-gray-500">None yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.history.quotations.map((q) => (
                      <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-700/40">
                        <span className="text-gray-900 dark:text-white">
                          {q.reference} · {q.job_name}
                        </span>
                        <span className="text-gray-600 dark:text-gray-300">
                          {formatMoney(q.total, q.currency)} · {q.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  <Receipt className="h-4 w-4" aria-hidden="true" />
                  Invoices ({detail.history.invoices.length})
                </h3>
                {detail.history.invoices.length === 0 ? (
                  <p className="text-sm text-gray-500">None yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.history.invoices.map((i) => (
                      <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-700/40">
                        <span className="text-gray-900 dark:text-white">
                          {i.reference} · {i.job_name}
                        </span>
                        <span className="text-gray-600 dark:text-gray-300">
                          {formatMoney(i.total, i.currency)} · due {formatDate(i.due_date)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
                  Jobs ({detail.history.jobs.length})
                </h3>
                {detail.history.jobs.length === 0 ? (
                  <p className="text-sm text-gray-500">None yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.history.jobs.map((j) => (
                      <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-700/40">
                        <span className="text-gray-900 dark:text-white">
                          {j.reference} · {j.job_name}
                        </span>
                        <span className="text-gray-600 dark:text-gray-300">
                          {j.agreed_price !== null ? `${formatMoney(j.agreed_price, j.currency)} · ` : ""}
                          {j.status.replace(/_/g, " ")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
