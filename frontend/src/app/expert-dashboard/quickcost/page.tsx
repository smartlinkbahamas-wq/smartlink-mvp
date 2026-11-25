"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Calculator, Loader2, Plus, Save, Trash2, TriangleAlert } from "lucide-react";

import { getAdminAccessToken, getSessionMe } from "@/lib/admin-session";
import { canUseExpertSection } from "@/lib/role-guard";
import {
  listEstimates,
  createEstimate,
  updateEstimate,
  deleteEstimate,
  formatMoney,
} from "@/lib/business-hub-api";
import type { CostItem, CostKind, QuickCostEstimate } from "@/types";

/**
 * QuickCost: what a job costs, and what it should therefore be sold for.
 *
 * Nothing on this screen is ever shown to a customer. The figures here are
 * recomputed live for feedback, but the server recomputes everything on save --
 * the figures sent in the request body are never trusted.
 */

const KINDS: Array<{ value: CostKind; label: string; qtyLabel: string; unitLabel: string }> = [
  { value: "material", label: "Materials", qtyLabel: "Qty", unitLabel: "Unit cost" },
  { value: "labour", label: "Labour", qtyLabel: "Hours", unitLabel: "Cost per hour" },
  { value: "subcontractor", label: "Subcontractor", qtyLabel: "Qty", unitLabel: "Cost" },
  { value: "transport", label: "Transport", qtyLabel: "Qty", unitLabel: "Cost" },
  { value: "equipment", label: "Equipment", qtyLabel: "Qty", unitLabel: "Cost" },
  { value: "other", label: "Other", qtyLabel: "Qty", unitLabel: "Cost" },
];

interface Draft {
  id: string | null;
  jobName: string;
  customerSummary: string;
  internalNotes: string;
  costItems: CostItem[];
  overheadAmount: string;
  targetMarginPercent: string;
  finalPrice: string;
}

const EMPTY: Draft = {
  id: null,
  jobName: "",
  customerSummary: "",
  internalNotes: "",
  costItems: [],
  overheadAmount: "",
  targetMarginPercent: "30",
  finalPrice: "",
};

const num = (value: string | number | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export default function QuickCostPage() {
  const router = useRouter();
  const [estimates, setEstimates] = useState<QuickCostEstimate[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
        const rows = await listEstimates(token);
        if (active) setEstimates(rows);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Could not load your estimates.");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [router]);

  /**
   * Mirrors the server's arithmetic so the provider sees the effect of a change
   * immediately. The server recomputes on save and its answer wins.
   */
  const computed = useMemo(() => {
    const itemsCost = round2(
      draft.costItems.reduce((sum, item) => sum + round2(num(item.quantity) * num(item.unitCost)), 0),
    );
    const totalCost = round2(itemsCost + num(draft.overheadAmount));
    const margin = Math.min(num(draft.targetMarginPercent), 99);
    // price = cost / (1 - margin). Margin, not markup: $1,000 at 30% margin is
    // $1,428.57, which is a 42.86% markup.
    const suggested = margin > 0 ? round2(totalCost / (1 - margin / 100)) : totalCost;
    const finalPrice = draft.finalPrice === "" ? suggested : round2(num(draft.finalPrice));
    const profit = round2(finalPrice - totalCost);
    const marginPercent = finalPrice > 0 ? round2((profit / finalPrice) * 100) : 0;
    const markupPercent = totalCost > 0 ? round2((profit / totalCost) * 100) : 0;

    return { itemsCost, totalCost, suggested, finalPrice, profit, marginPercent, markupPercent };
  }, [draft]);

  function requireToken() {
    const token = getAdminAccessToken();
    if (!token) {
      router.replace("/login");
      return null;
    }
    return token;
  }

  function addItem(kind: CostKind) {
    setDraft((current) => ({
      ...current,
      costItems: [...current.costItems, { kind, label: "", quantity: 1, unitCost: 0 }],
    }));
  }

  function patchItem(index: number, patch: Partial<CostItem>) {
    setDraft((current) => ({
      ...current,
      costItems: current.costItems.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    }));
  }

  function loadEstimate(estimate: QuickCostEstimate) {
    setDraft({
      id: estimate.id,
      jobName: estimate.job_name,
      customerSummary: estimate.customer_summary || "",
      internalNotes: estimate.internal_notes || "",
      costItems: estimate.cost_items || [],
      overheadAmount: String(estimate.overhead_amount || ""),
      targetMarginPercent: String(estimate.target_margin_percent || 0),
      finalPrice: String(estimate.final_price || ""),
    });
    setNotice("");
    setError("");
  }

  async function handleSave() {
    const token = requireToken();
    if (!token) return;

    setSaving(true);
    setError("");
    setNotice("");

    const payload = {
      jobName: draft.jobName.trim(),
      customerSummary: draft.customerSummary.trim() || undefined,
      internalNotes: draft.internalNotes.trim() || undefined,
      costItems: draft.costItems
        .filter((item) => item.label.trim())
        .map((item) => ({
          kind: item.kind,
          label: item.label.trim(),
          quantity: num(item.quantity),
          unitCost: num(item.unitCost),
        })),
      overheadAmount: num(draft.overheadAmount),
      targetMarginPercent: Math.min(num(draft.targetMarginPercent), 99),
      // Empty means "use the suggested price", which the server resolves.
      finalPrice: draft.finalPrice === "" ? null : num(draft.finalPrice),
    };

    try {
      if (draft.id) {
        const saved = await updateEstimate(draft.id, payload, token);
        setEstimates((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
        setNotice(`Saved. ${formatMoney(saved.profit)} profit at ${saved.margin_percent}% margin.`);
      } else {
        const saved = await createEstimate(payload, token);
        setEstimates((rows) => [saved, ...rows]);
        setDraft((current) => ({ ...current, id: saved.id }));
        setNotice(`Saved. ${formatMoney(saved.profit)} profit at ${saved.margin_percent}% margin.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that estimate.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(estimate: QuickCostEstimate) {
    if (!window.confirm(`Remove the estimate for "${estimate.job_name}"?`)) return;
    const token = requireToken();
    if (!token) return;

    try {
      await deleteEstimate(estimate.id, token);
      setEstimates((rows) => rows.filter((row) => row.id !== estimate.id));
      if (draft.id === estimate.id) setDraft(EMPTY);
      setNotice("Estimate removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that estimate.");
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
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <Calculator className="h-6 w-6 text-blue-600" aria-hidden="true" />
          Job Cost Calculator
        </h1>
        <p className="mt-1 text-gray-500">
          Work out what a job costs you and what to charge. Only you see these figures.
        </p>
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {notice && !error ? (
        <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900/50 dark:bg-green-900/20 dark:text-green-300">
          {notice}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <div className="space-y-5 rounded-xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
          <div>
            <label htmlFor="job-name" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              Job name
            </label>
            <input
              id="job-name"
              value={draft.jobName}
              onChange={(event) => setDraft({ ...draft, jobName: event.target.value })}
              placeholder="Rewire ground floor — Thompson"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="customer-summary" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              Customer summary{" "}
              <span className="font-normal text-gray-500">— this is the only text that can go on a quotation</span>
            </label>
            <textarea
              id="customer-summary"
              value={draft.customerSummary}
              onChange={(event) => setDraft({ ...draft, customerSummary: event.target.value })}
              rows={2}
              placeholder="What the customer is getting."
              className={inputClass}
            />
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-white">Costs</span>
              <div className="flex flex-wrap gap-1">
                {KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    type="button"
                    onClick={() => addItem(kind.value)}
                    className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    <Plus className="mr-1 inline h-3 w-3" aria-hidden="true" />
                    {kind.label}
                  </button>
                ))}
              </div>
            </div>

            {draft.costItems.length === 0 ? (
              <p className="rounded-lg border border-dashed border-gray-300 p-4 text-center text-sm text-gray-500 dark:border-gray-600">
                Add materials, labour hours, transport and anything else this job costs you.
              </p>
            ) : (
              <div className="space-y-2">
                {draft.costItems.map((item, index) => {
                  const kind = KINDS.find((k) => k.value === item.kind) || KINDS[0];
                  const lineCost = round2(num(item.quantity) * num(item.unitCost));

                  return (
                    <div key={index} className="flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-2 dark:bg-gray-700/40">
                      <span className="w-full text-xs font-semibold uppercase text-gray-500 sm:w-20">
                        {kind.label}
                      </span>
                      <input
                        value={item.label}
                        onChange={(event) => patchItem(index, { label: event.target.value })}
                        placeholder="Description"
                        className="min-w-[8rem] flex-1 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                        aria-label={`Cost line ${index + 1} description`}
                      />
                      <input
                        inputMode="decimal"
                        value={String(item.quantity)}
                        onChange={(event) =>
                          patchItem(index, { quantity: num(event.target.value.replace(/[^\d.]/g, "")) })
                        }
                        className="w-20 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                        aria-label={`${kind.qtyLabel} for line ${index + 1}`}
                        placeholder={kind.qtyLabel}
                      />
                      <input
                        inputMode="decimal"
                        value={String(item.unitCost)}
                        onChange={(event) =>
                          patchItem(index, { unitCost: num(event.target.value.replace(/[^\d.]/g, "")) })
                        }
                        className="w-28 rounded-lg border border-gray-300 p-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-white"
                        aria-label={`${kind.unitLabel} for line ${index + 1}`}
                        placeholder={kind.unitLabel}
                      />
                      <span className="w-24 text-right text-sm font-semibold text-gray-900 dark:text-white">
                        {formatMoney(lineCost)}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            costItems: draft.costItems.filter((_, i) => i !== index),
                          })
                        }
                        className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                        aria-label={`Remove cost line ${index + 1}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="overhead" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
                Overhead for this job
              </label>
              <input
                id="overhead"
                inputMode="decimal"
                value={draft.overheadAmount}
                onChange={(event) =>
                  setDraft({ ...draft, overheadAmount: event.target.value.replace(/[^\d.]/g, "") })
                }
                placeholder="0.00"
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="margin" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
                Target margin %
              </label>
              <input
                id="margin"
                inputMode="decimal"
                value={draft.targetMarginPercent}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    targetMarginPercent: event.target.value.replace(/[^\d.]/g, ""),
                  })
                }
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label htmlFor="internal-notes" className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              Private notes <span className="font-normal text-gray-500">— never leaves this page</span>
            </label>
            <textarea
              id="internal-notes"
              value={draft.internalNotes}
              onChange={(event) => setDraft({ ...draft, internalNotes: event.target.value })}
              rows={2}
              className={inputClass}
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !draft.jobName.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {draft.id ? "Save changes" : "Save estimate"}
            </button>
            {draft.id ? (
              <button
                type="button"
                onClick={() => setDraft(EMPTY)}
                className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Start a new estimate
              </button>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              What this job costs you
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">Items</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{formatMoney(computed.itemsCost)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">Overhead</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{formatMoney(num(draft.overheadAmount))}</dd>
              </div>
              <div className="flex justify-between border-t border-gray-200 pt-2 dark:border-gray-700">
                <dt className="font-semibold text-gray-900 dark:text-white">Total cost</dt>
                <dd className="font-bold text-gray-900 dark:text-white">{formatMoney(computed.totalCost)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-gray-100 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Your price</h2>

            <p className="mt-3 text-xs text-gray-500">
              Suggested at {num(draft.targetMarginPercent)}% margin
            </p>
            <p className="text-2xl font-bold text-blue-600">{formatMoney(computed.suggested)}</p>

            <label htmlFor="final-price" className="mb-1 mt-4 block text-sm font-medium text-gray-900 dark:text-white">
              Charge instead <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id="final-price"
              inputMode="decimal"
              value={draft.finalPrice}
              onChange={(event) =>
                setDraft({ ...draft, finalPrice: event.target.value.replace(/[^\d.]/g, "") })
              }
              placeholder={String(computed.suggested.toFixed(2))}
              className={inputClass}
            />

            <dl className="mt-4 space-y-2 border-t border-gray-200 pt-3 text-sm dark:border-gray-700">
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">Profit</dt>
                <dd className={`font-bold ${computed.profit < 0 ? "text-red-600" : "text-green-700 dark:text-green-400"}`}>
                  {formatMoney(computed.profit)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-600 dark:text-gray-400">Margin</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{computed.marginPercent}%</dd>
              </div>
              <div className="flex justify-between">
                {/* Shown alongside margin so nobody has to guess which was used.
                    30% margin and 30% markup are different prices. */}
                <dt className="text-gray-600 dark:text-gray-400">Markup</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{computed.markupPercent}%</dd>
              </div>
            </dl>

            {computed.profit < 0 ? (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  This price is below what the job costs you. You would lose{" "}
                  {formatMoney(Math.abs(computed.profit))}.
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Saved estimates</h2>
        {estimates.length === 0 ? (
          <p className="rounded-xl border border-gray-100 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800">
            Nothing saved yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {estimates.map((estimate) => (
              <li
                key={estimate.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 dark:text-white">{estimate.job_name}</p>
                  <p className="text-xs text-gray-500">
                    Cost {formatMoney(estimate.total_cost)} · Price {formatMoney(estimate.final_price)} ·{" "}
                    <span className={Number(estimate.profit) < 0 ? "text-red-600" : ""}>
                      {formatMoney(estimate.profit)} profit ({estimate.margin_percent}% margin)
                    </span>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => loadEstimate(estimate)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(estimate)}
                    className="rounded-lg p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                    aria-label={`Remove ${estimate.job_name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
