const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const {
  round2,
  lineTotalCents,
  fromCents,
  priceFromCostAndMargin,
  marginFromCostAndPrice,
} = require("../utils/money");

/**
 * QuickCost: what a job costs the provider, and what it should be sold for.
 *
 * The rule that governs this whole file: none of it reaches a customer. Cost,
 * labour rates, overhead and profit are internal. The only values that cross
 * into a quotation are the job name, the customer-facing summary and the
 * final price, and they cross through getQuoteBasis() alone -- one function,
 * so there is one place to audit instead of a boundary spread across the
 * codebase.
 */

const COST_KINDS = ["material", "labour", "subcontractor", "transport", "equipment", "other"];

const NOT_INSTALLED = "The cost calculator is not set up yet. Run sql/install_quickcost.sql.";

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "quickcost_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

/**
 * The whole calculation, derived from inputs only.
 *
 * Called on every write. The request body never carries a total, a profit or a
 * margin, so none of those can be forged by a client -- which matters, because
 * these figures will later feed provider profitability reporting.
 */
function computeEstimate({ costItems = [], overheadAmount = 0, targetMarginPercent = 0, finalPrice = null }) {
  // Rounded per line before summing, so the figures a provider reads down the
  // screen add up to the total printed at the bottom.
  const items = costItems.map((item) => {
    const cents = lineTotalCents(item.quantity ?? 1, item.unitCost ?? 0);
    return {
      kind: COST_KINDS.includes(item.kind) ? item.kind : "other",
      label: String(item.label || "").trim(),
      quantity: Number(item.quantity ?? 1),
      unitCost: round2(item.unitCost ?? 0),
      lineCost: fromCents(cents),
      _cents: cents,
    };
  });

  const itemsCostCents = items.reduce((sum, item) => sum + item._cents, 0);
  const itemsCost = fromCents(itemsCostCents);
  const overhead = round2(overheadAmount);
  const totalCost = round2(itemsCost + overhead);

  const suggested = priceFromCostAndMargin(totalCost, targetMarginPercent);

  // An override of 0 is meaningful -- a provider may genuinely quote nothing,
  // for a goodwill job -- so only null/undefined falls back to the suggestion.
  const resolvedFinal =
    finalPrice === null || finalPrice === undefined ? suggested.price : round2(finalPrice);

  const outcome = marginFromCostAndPrice(totalCost, resolvedFinal);

  return {
    costItems: items.map(({ _cents, ...item }) => item),
    itemsCost,
    overheadAmount: overhead,
    totalCost,
    targetMarginPercent: round2(targetMarginPercent),
    suggestedPrice: suggested.price,
    finalPrice: resolvedFinal,
    profit: outcome.profit,
    marginPercent: outcome.marginPercent,
    markupPercent: outcome.markupPercent,
    belowCost: outcome.belowCost,
  };
}

function toRow(payload) {
  const computed = computeEstimate({
    costItems: payload.costItems || [],
    overheadAmount: payload.overheadAmount || 0,
    targetMarginPercent: payload.targetMarginPercent || 0,
    finalPrice: payload.finalPrice ?? null,
  });

  return {
    job_name: String(payload.jobName).trim(),
    customer_summary: payload.customerSummary?.trim() || null,
    internal_notes: payload.internalNotes?.trim() || null,
    cost_items: computed.costItems,
    overhead_amount: computed.overheadAmount,
    target_margin_percent: computed.targetMarginPercent,
    items_cost: computed.itemsCost,
    total_cost: computed.totalCost,
    suggested_price: computed.suggestedPrice,
    final_price: computed.finalPrice,
    profit: computed.profit,
    margin_percent: computed.marginPercent,
    markup_percent: computed.markupPercent,
    status: payload.status || "draft",
  };
}

async function listEstimates(expertId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("quickcost_estimates")
    .select("*")
    .eq("expert_id", expertId)
    .order("created_at", { ascending: false });

  if (error) guard(error, "Could not load your cost estimates.");
  return data || [];
}

async function getEstimate(expertId, estimateId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("quickcost_estimates")
    .select("*")
    .eq("id", estimateId)
    .eq("expert_id", expertId)
    .maybeSingle();

  if (error) guard(error, "Could not load that cost estimate.");
  if (!data) {
    throw new AppError("That estimate could not be found.", 404, { code: "estimate_not_found" });
  }
  return data;
}

async function createEstimate(expertId, payload) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("quickcost_estimates")
    .insert({ ...toRow(payload), expert_id: expertId })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23503") {
      throw new AppError("No provider profile is linked to this account.", 403, {
        code: "expert_profile_not_linked",
      });
    }
    guard(error, "Could not save that cost estimate.");
  }
  return data;
}

async function updateEstimate(expertId, estimateId, payload) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("quickcost_estimates")
    .update({ ...toRow(payload), updated_at: new Date().toISOString() })
    .eq("id", estimateId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not save that cost estimate.");
  if (!data) {
    throw new AppError("That estimate could not be found.", 404, { code: "estimate_not_found" });
  }
  return data;
}

async function deleteEstimate(expertId, estimateId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("quickcost_estimates")
    .delete()
    .eq("id", estimateId)
    .eq("expert_id", expertId)
    .select("id")
    .maybeSingle();

  if (error) guard(error, "Could not remove that cost estimate.");
  if (!data) {
    throw new AppError("That estimate could not be found.", 404, { code: "estimate_not_found" });
  }
  return { id: data.id };
}

/** Records what the job actually cost and earned, for estimate-vs-actual. */
async function recordActuals(expertId, estimateId, { actualCost, actualRevenue }) {
  const supabase = requireSupabase();

  const { data, error } = await supabase
    .from("quickcost_estimates")
    .update({
      actual_cost: actualCost === null || actualCost === undefined ? null : round2(actualCost),
      actual_revenue:
        actualRevenue === null || actualRevenue === undefined ? null : round2(actualRevenue),
      actual_recorded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", estimateId)
    .eq("expert_id", expertId)
    .select("*")
    .maybeSingle();

  if (error) guard(error, "Could not record those figures.");
  if (!data) {
    throw new AppError("That estimate could not be found.", 404, { code: "estimate_not_found" });
  }
  return data;
}

/**
 * THE confidentiality boundary.
 *
 * Everything a quotation is allowed to know about a cost estimate, and nothing
 * else. Written as an explicit object rather than a destructure-and-spread so
 * that adding a column to quickcost_estimates cannot silently widen what a
 * customer document can see.
 *
 * If a future field genuinely belongs on a customer document, it is added here
 * deliberately, in a diff someone reviews.
 */
function getQuoteBasis(estimate) {
  if (!estimate) return null;
  return {
    jobName: estimate.job_name,
    customerSummary: estimate.customer_summary || null,
    finalPrice: Number(estimate.final_price),
    currency: estimate.currency || "USD",
    sourceEstimateId: estimate.id,
  };
}

module.exports = {
  COST_KINDS,
  computeEstimate,
  listEstimates,
  getEstimate,
  createEstimate,
  updateEstimate,
  deleteEstimate,
  recordActuals,
  getQuoteBasis,
};
