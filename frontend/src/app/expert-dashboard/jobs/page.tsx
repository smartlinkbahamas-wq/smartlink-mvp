"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, CalendarClock, Loader2, Plus, TriangleAlert, X } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listJobs,
  createManualJob,
  updateJobStatus,
  reviseJobDate,
  formatMoney,
} from "@/lib/business-hub-api";
import type { Job } from "@/types";

/**
 * Jobs: work that was actually awarded.
 *
 * Statuses a provider cannot set are deliberately absent from the control:
 * customer-confirmed, disputed and unverifiable are reached by the customer or
 * an administrator. A provider marking their own work customer-confirmed would
 * make the confirmation step meaningless.
 */

const PROVIDER_STATUSES: Array<{ value: string; label: string }> = [
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "Work in progress" },
  { value: "delayed", label: "Delayed" },
  { value: "provider_completed", label: "Mark as completed" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_STYLES: Record<string, string> = {
  awarded: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  scheduled: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  delayed: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  provider_completed: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  customer_confirmed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  disputed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  unverifiable: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
};

const STATUS_LABELS: Record<string, string> = {
  awarded: "Awarded",
  scheduled: "Scheduled",
  in_progress: "In progress",
  delayed: "Delayed",
  provider_completed: "Completed — awaiting customer",
  customer_confirmed: "Confirmed by customer",
  disputed: "Disputed",
  cancelled: "Cancelled",
  unverifiable: "Unverifiable",
};

function formatDate(value: string | null) {
  if (!value) return "not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "not set"
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function JobsPage() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    jobName: "",
    description: "",
    agreedPrice: "",
    expectedCompletionDate: "",
  });
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
        const rows = await listJobs(token);
        if (active) setJobs(rows);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your jobs.");
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

  async function handleStatus(job: Job, status: string) {
    // Completion requires a date. Asked for here so the provider is not sent a
    // bare rejection from the server.
    let actualCompletionDate: string | undefined;
    if (status === "provider_completed") {
      const entered = window.prompt(
        "What date was the work completed? (YYYY-MM-DD)",
        new Date().toISOString().slice(0, 10),
      );
      if (!entered) return;
      actualCompletionDate = entered;
    }

    return run(job.id, async () => {
      const token = requireToken();
      if (!token) return;
      const updated = await updateJobStatus(job.id, { status, actualCompletionDate }, token);
      setJobs((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setNotice(`${updated.reference} is now "${STATUS_LABELS[updated.status]}".`);
    });
  }

  async function handleReviseDate(job: Job) {
    const requestedDate = window.prompt(
      "New expected completion date (YYYY-MM-DD)",
      job.expected_completion_date || new Date().toISOString().slice(0, 10),
    );
    if (!requestedDate) return;

    const reason = window.prompt(
      "Why is the date changing? (material delays, additional customer requirements, changes to agreed work)",
    );
    if (!reason) return;

    return run(job.id, async () => {
      const token = requireToken();
      if (!token) return;
      const result = await reviseJobDate(job.id, { requestedDate, reason }, token);
      setJobs((rows) => rows.map((row) => (row.id === result.data.job.id ? result.data.job : row)));
      setNotice(result.message);
    });
  }

  async function handleAdd() {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setFormError("");

    try {
      const job = await createManualJob(
        {
          customerName: form.customerName.trim(),
          customerEmail: form.customerEmail.trim() || undefined,
          customerPhone: form.customerPhone.trim() || undefined,
          jobName: form.jobName.trim(),
          description: form.description.trim() || undefined,
          agreedPrice: form.agreedPrice ? Number(form.agreedPrice) : null,
          expectedCompletionDate: form.expectedCompletionDate || null,
        },
        token,
      );
      setJobs((rows) => [job, ...rows]);
      setNotice(`${job.reference} added.`);
      setAddOpen(false);
      setForm({
        customerName: "",
        customerEmail: "",
        customerPhone: "",
        jobName: "",
        description: "",
        agreedPrice: "",
        expectedCompletionDate: "",
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not add that job.");
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
  const overdue = jobs.filter((job) => job.is_overdue);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <Briefcase className="h-6 w-6 text-blue-600" aria-hidden="true" />
            Jobs
          </h1>
          <p className="mt-1 text-gray-500">Work you have been awarded, on and off SmartLink.</p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a job
        </button>
      </div>

      {overdue.length > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {overdue.length} {overdue.length === 1 ? "job is" : "jobs are"} past the expected
            completion date. Update the status or request a new date.
          </span>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">{error}</div>
      ) : null}
      {notice && !error ? (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} className="underline">Dismiss</button>
        </div>
      ) : null}

      {jobs.length === 0 ? (
        <div className="rounded-xl border border-gray-100 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">No jobs yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            A job is created when a customer approves a quotation, or you can add one by hand for
            work that came from elsewhere.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => {
            const busy = busyId === job.id;
            const closed = ["customer_confirmed", "cancelled", "unverifiable"].includes(job.status);

            return (
              <li key={job.id} className="rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-gray-900 dark:text-white">{job.job_name}</h3>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[job.status]}`}>
                        {STATUS_LABELS[job.status]}
                      </span>
                      {/* Recorded at creation and never changed: it is what keeps
                          platform conversion honest. */}
                      <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {job.source === "smartlink" ? "From SmartLink" : "Your own customer"}
                      </span>
                      {job.is_overdue ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">
                          {job.overdue_days} {job.overdue_days === 1 ? "day" : "days"} overdue
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-gray-500">
                      {job.reference} · {job.customer_name}
                      {job.customer_email ? ` · ${job.customer_email}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      Expected {formatDate(job.expected_completion_date)}
                      {job.actual_completion_date ? ` · Completed ${formatDate(job.actual_completion_date)}` : ""}
                      {job.original_expected_completion_date &&
                      job.original_expected_completion_date !== job.expected_completion_date
                        ? ` · originally ${formatDate(job.original_expected_completion_date)}`
                        : ""}
                    </p>
                  </div>
                  {job.agreed_price !== null ? (
                    <p className="text-lg font-bold text-gray-900 dark:text-white">
                      {formatMoney(job.agreed_price, job.currency)}
                    </p>
                  ) : null}
                </div>

                {!closed ? (
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4 dark:border-gray-700">
                    <label htmlFor={`status-${job.id}`} className="sr-only">Change status</label>
                    <select
                      id={`status-${job.id}`}
                      value=""
                      disabled={busy}
                      onChange={(event) => {
                        if (event.target.value) handleStatus(job, event.target.value);
                      }}
                      className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                    >
                      <option value="">Change status…</option>
                      {PROVIDER_STATUSES.filter((option) => option.value !== job.status).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() => handleReviseDate(job)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                      {job.work_started ? "Request a new date" : "Change expected date"}
                    </button>

                    {busy ? <Loader2 className="h-4 w-4 animate-spin text-blue-600" /> : null}

                    {job.work_started ? (
                      <span className="text-xs text-gray-500">
                        Work has started, so a date change needs administrator approval.
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {addOpen ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-10" role="dialog" aria-modal="true" aria-labelledby="job-title" onClick={() => !saving && setAddOpen(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="job-title" className="text-lg font-semibold text-gray-900 dark:text-white">Add a job</h2>
                <p className="mt-1 text-sm text-gray-500">
                  For work that did not come through SmartLink. It is recorded as your own customer
                  so platform reporting stays accurate.
                </p>
              </div>
              <button type="button" onClick={() => setAddOpen(false)} disabled={saving} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            {formError ? (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">{formError}</div>
            ) : null}

            <div className="space-y-3">
              <div>
                <label htmlFor="j-job" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Job name</label>
                <input id="j-job" value={form.jobName} onChange={(e) => setForm({ ...form, jobName: e.target.value })} className={inputClass} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="j-customer" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Customer name</label>
                  <input id="j-customer" value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="j-email" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Email <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="j-email" type="email" value={form.customerEmail} onChange={(e) => setForm({ ...form, customerEmail: e.target.value })} className={inputClass} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="j-price" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Agreed price <span className="font-normal text-gray-500">(optional)</span></label>
                  <input id="j-price" inputMode="decimal" value={form.agreedPrice} onChange={(e) => setForm({ ...form, agreedPrice: e.target.value.replace(/[^\d.]/g, "") })} className={inputClass} />
                </div>
                <div>
                  <label htmlFor="j-date" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Expected completion</label>
                  <input id="j-date" type="date" value={form.expectedCompletionDate} onChange={(e) => setForm({ ...form, expectedCompletionDate: e.target.value })} className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor="j-desc" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Description <span className="font-normal text-gray-500">(optional)</span></label>
                <textarea id="j-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputClass} />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" onClick={() => setAddOpen(false)} disabled={saving} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
              <button type="button" onClick={handleAdd} disabled={saving || !form.jobName.trim() || !form.customerName.trim()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Add job
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
