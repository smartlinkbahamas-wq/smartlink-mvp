"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BarChart3, Loader2, TriangleAlert } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import { getMyReport, formatRate, formatMoney } from "@/lib/business-hub-api";
import type { ProviderReport } from "@/types";

/**
 * A provider's own figures.
 *
 * Three things this screen refuses to do:
 *
 * - Show a percentage without the counts behind it. "22%" from nine inquiries
 *   reads as precision that is not there; "2 of 9" does not.
 *
 * - Merge completion states. Provider-reported, customer-confirmed and
 *   unverifiable are different claims and are shown as different numbers.
 *
 * - Present self-reported revenue as verified. Payment happens off the
 *   platform, so these are the provider's own records and the screen says so.
 */

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "text-green-700 dark:text-green-400"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : tone === "bad"
          ? "text-red-700 dark:text-red-400"
          : "text-gray-900 dark:text-white";

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${toneClass}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
        {note ? <p className="mt-1 text-sm text-gray-500">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

export default function ProviderReportsPage() {
  const router = useRouter();
  const [report, setReport] = useState<ProviderReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
        const data = await getMyReport(token);
        if (active) setReport(data);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your figures.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
        {error || "No figures available."}
      </div>
    );
  }

  const { inquiries, quotations, jobs, revenue, profitability } = report;
  const nothingYet = inquiries.received === 0 && jobs.total === 0 && quotations.created === 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <BarChart3 className="h-6 w-6 text-blue-600" aria-hidden="true" />
          Your Business
        </h1>
        <p className="mt-1 text-gray-500">
          Everything on this page is yours alone. SmartLink administrators never see your costs or
          your profit.
        </p>
      </div>

      {nothingYet ? (
        <div className="rounded-xl border border-gray-100 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
          <p className="font-medium text-gray-900 dark:text-white">Nothing to report yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            These figures fill in as you accept opportunities, send quotations and complete work.
          </p>
        </div>
      ) : null}

      <Section
        title="Opportunities"
        note="Inquiries SmartLink sent you, and what you did with them."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Received" value={inquiries.received} />
          <Stat label="Accepted" value={inquiries.accepted} />
          <Stat label="Declined" value={inquiries.declined} />
          <Stat
            label="Acceptance rate"
            value={formatRate(inquiries.acceptanceRate)}
            hint="Declining a lead you reported as suspicious does not count against you."
          />
        </div>
      </Section>

      <Section title="Quotations">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Created" value={quotations.created} />
          <Stat label="Sent to customers" value={quotations.sent} />
          <Stat
            label="Approved"
            value={formatRate(quotations.approvalRate)}
            hint="Of those actually sent — drafts never had a chance to be approved."
            tone="good"
          />
          <Stat label="Value approved" value={formatMoney(quotations.approvedValue)} />
        </div>
      </Section>

      <Section
        title="Jobs"
        note="Completion states are counted separately on purpose. Work you reported complete is a different thing from work a customer confirmed."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Total" value={jobs.total} hint={`${jobs.fromSmartLink} from SmartLink · ${jobs.ownCustomers} your own`} />
          <Stat label="In progress" value={jobs.inProgress} />
          <Stat
            label="You reported complete"
            value={jobs.providerReportedComplete}
            hint="Waiting on the customer to confirm."
            tone="warn"
          />
          <Stat label="Customer confirmed" value={jobs.customerConfirmed} tone="good" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Unverifiable"
            value={jobs.unverifiable}
            hint="Customer never responded. Counted as neither confirmed nor disputed."
          />
          <Stat label="Disputed" value={jobs.disputed} tone={jobs.disputed > 0 ? "bad" : "default"} />
          <Stat label="Cancelled" value={jobs.cancelled} />
          <Stat
            label="Finished on time"
            value={formatRate(jobs.onTime)}
            hint="Of completed jobs that had an expected date."
          />
        </div>
      </Section>

      <Section
        title="Money"
        note="Payment happens directly between you and your customer, so these are your own records rather than anything SmartLink verified."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Invoiced" value={formatMoney(revenue.invoiced)} />
          <Stat label="Received" value={formatMoney(revenue.received)} tone="good" />
          <Stat
            label="Outstanding"
            value={formatMoney(revenue.outstanding)}
            tone={revenue.outstanding > 0 ? "warn" : "default"}
            hint="On invoices you have sent."
          />
          <Stat
            label="From confirmed work"
            value={formatMoney(revenue.estimatedFromConfirmedJobs)}
            hint="Agreed prices on jobs the customer confirmed."
          />
        </div>
      </Section>

      <Section title="Estimates versus reality">
        {profitability.estimatesRecorded === 0 ? (
          <p className="rounded-xl border border-gray-100 bg-white p-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800">
            Use the cost calculator to price a job, and the comparison between what you estimated
            and what it actually cost will appear here.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Stat label="Estimates recorded" value={profitability.estimatesRecorded} />
              <Stat
                label="Estimated profit"
                value={formatMoney(profitability.estimatedProfit)}
                tone={profitability.estimatedProfit < 0 ? "bad" : "good"}
              />
              <Stat
                label="With actuals recorded"
                value={profitability.comparisons}
                hint="Only these can be compared."
              />
            </div>

            {profitability.comparisons > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white dark:border-gray-700 dark:bg-gray-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700">
                      <th className="p-3"> </th>
                      <th className="p-3 text-right">Estimated</th>
                      <th className="p-3 text-right">Actual</th>
                      <th className="p-3 text-right">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: "Cost", estimated: profitability.estimatedCost, actual: profitability.actualCost, lowerIsBetter: true },
                      { label: "Revenue", estimated: profitability.estimatedRevenue, actual: profitability.actualRevenue, lowerIsBetter: false },
                    ].map((row) => {
                      const difference = (row.actual ?? 0) - (row.estimated ?? 0);
                      const good = row.lowerIsBetter ? difference <= 0 : difference >= 0;
                      return (
                        <tr key={row.label} className="border-b border-gray-50 last:border-0 dark:border-gray-700/50">
                          <td className="p-3 font-medium text-gray-900 dark:text-white">{row.label}</td>
                          <td className="p-3 text-right text-gray-700 dark:text-gray-300">{formatMoney(row.estimated)}</td>
                          <td className="p-3 text-right text-gray-700 dark:text-gray-300">{formatMoney(row.actual)}</td>
                          <td className={`p-3 text-right font-semibold ${good ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                            {difference >= 0 ? "+" : ""}
                            {formatMoney(difference)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  You have estimates but no actual figures recorded against them yet, so there is
                  nothing to compare. Record what a job really cost once it is finished.
                </span>
              </div>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
