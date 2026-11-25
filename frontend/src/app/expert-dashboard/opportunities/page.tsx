"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Flag, Loader2, ShieldCheck, X } from "lucide-react";

import { getExpertDashboardData, updateOpportunityStatus } from "@/lib/backend-api";
import {
  reportSuspiciousLead,
  SUSPICIOUS_LEAD_REASONS,
  type SuspiciousLeadReason,
} from "@/lib/backend-api";
import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";

interface ReportableOpportunity {
  id: string;
  clientName?: string;
  category?: string;
}

export default function OpportunitiesPage() {
  const router = useRouter();
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Report Suspicious Lead. Reporting is deliberately separate from passing:
  // a provider may want an administrator to look at a lead whether or not they
  // also decline it, and declining a reported lead must not count against them.
  const [reportFor, setReportFor] = useState<ReportableOpportunity | null>(null);
  const [reason, setReason] = useState<SuspiciousLeadReason | "">("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState("");

  useEffect(() => {
    let active = true;
    async function loadData() {
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

        const response = await getExpertDashboardData(token);
        if (!active) return;
        setOpportunities(response.opportunities || []);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load opportunities.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    loadData();
    return () => {
      active = false;
    };
  }, [router]);

  async function handleAction(id: string, action: string) {
    let status = "";
    if (action === "accept") status = "accepted";
    else if (action === "pass") status = "declined";
    else if (action === "info") status = "more_info";

    setError("");

    try {
      const token = getAdminAccessToken();
      if (!token) {
        router.replace("/login");
        return;
      }

      await updateOpportunityStatus(id, status as "accepted" | "declined" | "more_info", token);
      setOpportunities((current) => current.filter((opp) => opp.id !== id));
    } catch (err) {
      // Previously this only reached the console, so a failed response looked
      // to the provider like nothing had happened at all.
      setError(err instanceof Error ? err.message : "Could not update that opportunity.");
    }
  }

  function openReport(opportunity: ReportableOpportunity) {
    setReportFor(opportunity);
    setReason("");
    setNotes("");
    setReportError("");
  }

  function closeReport() {
    if (submitting) return;
    setReportFor(null);
  }

  async function submitReport() {
    if (!reportFor || !reason) return;

    setSubmitting(true);
    setReportError("");

    try {
      const token = getAdminAccessToken();
      if (!token) {
        router.replace("/login");
        return;
      }

      const response = await reportSuspiciousLead(
        {
          introductionRequestId: reportFor.id,
          reason: reason as SuspiciousLeadReason,
          notes: notes.trim() || undefined,
        },
        token,
      );

      setReportedIds((current) => new Set(current).add(reportFor.id));
      setConfirmation(response.message || "Thanks — an administrator will review this.");
      setReportFor(null);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Could not send that report.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">New Opportunities</h1>
      <p className="text-gray-500">Review and respond to matching leads.</p>

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}

      {confirmation ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300"
        >
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{confirmation}</span>
          <button
            type="button"
            onClick={() => setConfirmation("")}
            className="shrink-0 underline"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="space-y-4">
        {opportunities.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 p-8 text-center rounded-xl border border-gray-100 dark:border-gray-700">
            <p className="text-gray-500">You have no new opportunities at this time.</p>
          </div>
        ) : (
          opportunities.map((opp) => {
            const reported = reportedIds.has(opp.id);

            return (
              <div
                key={opp.id}
                className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6"
              >
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white text-xl">
                      {opp.clientName}
                    </h3>
                    <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500 mt-1">
                      <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded font-medium">
                        {opp.matchScore}% Match
                      </span>
                      <span>{opp.category}</span>
                      {reported ? (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                          <Flag className="h-3 w-3" aria-hidden="true" />
                          Reported — under review
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className="text-sm text-gray-400">
                    Posted {new Date(opp.postedAt).toLocaleDateString()}
                  </span>
                </div>

                <p className="text-gray-700 dark:text-gray-300 mb-6">{opp.description}</p>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                  <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg">
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Urgency
                    </span>
                    <strong className="text-gray-900 dark:text-gray-200">{opp.urgency}</strong>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg">
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Location
                    </span>
                    <strong className="text-gray-900 dark:text-gray-200">{opp.location}</strong>
                  </div>
                  <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg">
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                      Budget Range
                    </span>
                    <strong className="text-gray-900 dark:text-gray-200">{opp.budgetRange}</strong>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-4 border-t border-gray-100 dark:border-gray-700">
                  <button
                    onClick={() => handleAction(opp.id, "accept")}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Accept Opportunity
                  </button>
                  <button
                    onClick={() => handleAction(opp.id, "pass")}
                    className="bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Pass
                  </button>
                  <button
                    onClick={() => handleAction(opp.id, "info")}
                    className="text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors"
                  >
                    Request More Info
                  </button>
                  <button
                    onClick={() => openReport(opp)}
                    disabled={reported}
                    className="ml-auto inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium text-gray-500 transition-colors hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                  >
                    <Flag className="h-4 w-4" aria-hidden="true" />
                    {reported ? "Reported" : "Report Suspicious Lead"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {reportFor ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="report-dialog-title"
          onClick={closeReport}
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2
                  id="report-dialog-title"
                  className="text-lg font-semibold text-gray-900 dark:text-white"
                >
                  Report suspicious lead
                </h2>
                <p className="mt-1 text-sm text-gray-500">
                  {reportFor.clientName} — {reportFor.category}
                </p>
              </div>
              <button
                type="button"
                onClick={closeReport}
                disabled={submitting}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-700"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="mb-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:bg-blue-900/20 dark:text-blue-200">
              An administrator will review this. Declining a reported lead will not count against
              your acceptance rate.
            </p>

            {reportError ? (
              <div
                role="alert"
                className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300"
              >
                {reportError}
              </div>
            ) : null}

            <fieldset className="mb-4 space-y-2">
              <legend className="mb-2 text-sm font-medium text-gray-900 dark:text-white">
                What is the problem?
              </legend>
              {SUSPICIOUS_LEAD_REASONS.map((item) => (
                <label
                  key={item.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
                    reason === item.value
                      ? "border-blue-600 bg-blue-50 dark:border-blue-500 dark:bg-blue-900/20"
                      : "border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="suspicious-reason"
                    value={item.value}
                    checked={reason === item.value}
                    onChange={() => setReason(item.value)}
                    className="mt-0.5"
                  />
                  <span className="text-gray-800 dark:text-gray-200">{item.label}</span>
                </label>
              ))}
            </fieldset>

            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              Anything else we should know? <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="For example, what the customer asked you for."
              className="mb-5 w-full rounded-lg border border-gray-300 p-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-white"
            />

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={closeReport}
                disabled={submitting}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitReport}
                disabled={!reason || submitting}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Send report
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
