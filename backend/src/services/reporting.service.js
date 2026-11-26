const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");
const { sumAmounts, round2 } = require("../utils/money");

/**
 * Reporting.
 *
 * Three rules govern everything in this file, and they are the reason it is
 * written the way it is rather than as a pile of counts:
 *
 * 1. EVERY RATE CARRIES ITS DENOMINATOR. "22%" is not a figure anyone can act
 *    on; "2 of 9" is. A percentage from a handful of rows reads as precision
 *    that is not there, so the numerator and denominator travel with it and
 *    the percent is null when the denominator is zero.
 *
 * 2. COMPLETION IS NEVER ONE NUMBER. Provider-reported, customer-confirmed,
 *    administrator-resolved and Unverifiable are counted separately and never
 *    merged. A platform that adds them together is claiming work was verified
 *    when nobody verified it.
 *
 * 3. ADMINISTRATORS SEE JOB VALUES, NEVER PROVIDER COST OR PROFIT. Enforced
 *    here by never querying quickcost_estimates in any administrator figure --
 *    there is nothing to strip because nothing is fetched. A provider's own
 *    profitability appears only in their own report, which is their data.
 *
 * SmartLink-originated work is kept distinct from provider-entered throughout,
 * using the `source` recorded at creation. Reporting that cannot separate work
 * the platform produced from work it merely stored is not worth running.
 */

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

/** A rate that can be read honestly: the parts, then the percent. */
function rate(numerator, denominator) {
  return {
    numerator,
    denominator,
    percent: denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : null,
  };
}

/** Reads a table, returning [] rather than throwing when it is not installed. */
async function safeSelect(builder, label) {
  const { data, error } = await builder;
  if (error) {
    if (tableIsMissing(error)) return [];
    console.warn(`[reporting] could not read ${label}:`, error.message);
    return [];
  }
  return data || [];
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) counts[row[field]] = (counts[row[field]] || 0) + 1;
  return counts;
}

// --- Provider report -------------------------------------------------------

/**
 * A provider's own figures.
 *
 * Includes their profitability, because it is their data about their own
 * business. Nothing here is visible to an administrator.
 */
async function getProviderReport(expertId) {
  const supabase = requireSupabase();

  const [introductions, quotations, invoices, payments, jobs, estimates] = await Promise.all([
    safeSelect(
      supabase.from("introduction_requests").select("id, status, created_at").eq("expert_id", expertId),
      "introductions",
    ),
    safeSelect(
      supabase.from("quotations").select("id, status, total, currency, valid_until, created_at").eq("expert_id", expertId),
      "quotations",
    ),
    safeSelect(
      supabase.from("invoices").select("id, total, status, due_date").eq("expert_id", expertId),
      "invoices",
    ),
    safeSelect(
      supabase.from("invoice_payments").select("invoice_id, amount").eq("expert_id", expertId),
      "payments",
    ),
    safeSelect(
      supabase.from("jobs").select("id, status, source, agreed_price, expected_completion_date, actual_completion_date").eq("expert_id", expertId),
      "jobs",
    ),
    safeSelect(
      supabase.from("quickcost_estimates").select("total_cost, final_price, profit, actual_cost, actual_revenue").eq("expert_id", expertId),
      "estimates",
    ),
  ]);

  const quotationStatus = countBy(quotations, "status");
  const jobStatus = countBy(jobs, "status");

  const approvedQuotations = quotations.filter((q) => q.status === "approved");
  const confirmedJobs = jobs.filter((j) => j.status === "customer_confirmed");

  // Estimate versus actual, from the provider's own cost estimates. Only rows
  // where an actual was recorded are compared -- averaging estimates against
  // nothing would read as perfect accuracy.
  const withActuals = estimates.filter(
    (e) => e.actual_cost !== null || e.actual_revenue !== null,
  );

  const paidByInvoice = new Map();
  for (const payment of payments) {
    paidByInvoice.set(
      payment.invoice_id,
      (paidByInvoice.get(payment.invoice_id) || 0) + Number(payment.amount),
    );
  }

  const sentInvoices = invoices.filter((i) => i.status === "sent");
  const outstanding = sentInvoices.reduce(
    (sum, invoice) => sum + Math.max(0, Number(invoice.total) - (paidByInvoice.get(invoice.id) || 0)),
    0,
  );

  // On time is measured against the actual completion date, and only for jobs
  // that actually completed. A job still open is not late yet; a cancelled job
  // was never going to complete.
  const completedWithDates = jobs.filter(
    (j) =>
      ["customer_confirmed", "provider_completed"].includes(j.status) &&
      j.expected_completion_date &&
      j.actual_completion_date,
  );
  const onTime = completedWithDates.filter(
    (j) => j.actual_completion_date <= j.expected_completion_date,
  );

  return {
    inquiries: {
      received: introductions.length,
      accepted: introductions.filter((i) => i.status === "accepted").length,
      declined: introductions.filter((i) => i.status === "declined").length,
      awaiting: introductions.filter((i) => ["submitted", "pending", "more_info"].includes(i.status)).length,
      acceptanceRate: rate(
        introductions.filter((i) => i.status === "accepted").length,
        introductions.length,
      ),
    },

    quotations: {
      created: quotations.length,
      sent: quotations.filter((q) => q.status !== "draft").length,
      approved: quotationStatus.approved || 0,
      declined: quotationStatus.declined || 0,
      changesRequested: quotationStatus.changes_requested || 0,
      // Of those actually sent: a draft never had a chance to be approved, so
      // including drafts would understate the real rate.
      approvalRate: rate(
        quotationStatus.approved || 0,
        quotations.filter((q) => q.status !== "draft").length,
      ),
      approvedValue: sumAmounts(approvedQuotations.map((q) => q.total)),
    },

    // Counted separately, never summed into one "completed" figure.
    jobs: {
      total: jobs.length,
      fromSmartLink: jobs.filter((j) => j.source === "smartlink").length,
      ownCustomers: jobs.filter((j) => j.source === "provider_entered").length,
      awarded: jobStatus.awarded || 0,
      inProgress: (jobStatus.in_progress || 0) + (jobStatus.scheduled || 0) + (jobStatus.delayed || 0),
      providerReportedComplete: jobStatus.provider_completed || 0,
      customerConfirmed: jobStatus.customer_confirmed || 0,
      disputed: jobStatus.disputed || 0,
      unverifiable: jobStatus.unverifiable || 0,
      cancelled: jobStatus.cancelled || 0,
      onTime: rate(onTime.length, completedWithDates.length),
    },

    revenue: {
      // Self-reported: payment happens off-platform, so this is what the
      // provider recorded, not what anyone verified.
      estimatedFromConfirmedJobs: sumAmounts(
        confirmedJobs.map((j) => j.agreed_price).filter((v) => v !== null),
      ),
      invoiced: sumAmounts(invoices.map((i) => i.total)),
      received: sumAmounts(payments.map((p) => p.amount)),
      outstanding: round2(outstanding),
    },

    profitability: {
      estimatesRecorded: estimates.length,
      estimatedProfit: sumAmounts(estimates.map((e) => e.profit)),
      // Only where an actual was recorded, with the count stated, so a single
      // comparison is not mistaken for a trend.
      comparisons: withActuals.length,
      estimatedCost: withActuals.length ? sumAmounts(withActuals.map((e) => e.total_cost)) : null,
      actualCost: withActuals.length ? sumAmounts(withActuals.map((e) => e.actual_cost || 0)) : null,
      estimatedRevenue: withActuals.length ? sumAmounts(withActuals.map((e) => e.final_price)) : null,
      actualRevenue: withActuals.length ? sumAmounts(withActuals.map((e) => e.actual_revenue || 0)) : null,
    },
  };
}

// --- Administrative report -------------------------------------------------

/**
 * The four report groups: completion and timeliness, satisfaction, support and
 * complaints, continual improvement.
 *
 * Nothing in here touches quickcost_estimates. Administrators see what a job
 * was worth, never what it cost the provider or what they made on it.
 */
async function getAdminReport() {
  const supabase = requireSupabase();

  const [leads, introductions, quotations, jobs, confirmations, surveys, providerSurveys, suspicious] =
    await Promise.all([
      safeSelect(supabase.from("lead_submissions").select("id, created_at"), "leads"),
      safeSelect(supabase.from("introduction_requests").select("id, status, lead_id, expert_id"), "introductions"),
      safeSelect(supabase.from("quotations").select("id, status, total, lead_id, expert_id"), "quotations"),
      safeSelect(
        supabase.from("jobs").select("id, status, source, agreed_price, expected_completion_date, actual_completion_date, expert_id"),
        "jobs",
      ),
      safeSelect(supabase.from("job_completion_confirmations").select("job_id, outcome"), "confirmations"),
      safeSelect(
        supabase.from("customer_satisfaction_surveys").select("overall_rating, quality_rating, timeliness_rating, professionalism_rating, communication_rating, would_recommend, would_use_smartlink_again, scope_as_agreed"),
        "customer surveys",
      ),
      safeSelect(
        supabase.from("provider_followup_surveys").select("resulted_in_job, opportunity_worthwhile, would_accept_similar, request_described_accurately, customer_responsive"),
        "provider surveys",
      ),
      safeSelect(supabase.from("suspicious_lead_reports").select("id, status, reason"), "suspicious reports"),
    ]);

  const jobStatus = countBy(jobs, "status");
  const smartlinkJobs = jobs.filter((j) => j.source === "smartlink");

  // --- The funnel, each step against the step before it -------------------
  const leadsWithIntroduction = new Set(introductions.map((i) => i.lead_id).filter(Boolean));
  const acceptedIntroductions = introductions.filter((i) => i.status === "accepted");
  const sentQuotations = quotations.filter((q) => q.status !== "draft");
  const approvedQuotations = quotations.filter((q) => q.status === "approved");

  const funnel = {
    leads: leads.length,
    reachedAnExpert: rate(leadsWithIntroduction.size, leads.length),
    acceptedByAnExpert: rate(acceptedIntroductions.length, introductions.length),
    quotationsSent: sentQuotations.length,
    quotationsApproved: rate(approvedQuotations.length, sentQuotations.length),
    // Only SmartLink-sourced jobs count toward the platform's own conversion.
    jobsFromSmartLink: smartlinkJobs.length,
    jobsFromProviders: jobs.length - smartlinkJobs.length,
    leadsBecomingWork: rate(smartlinkJobs.length, leads.length),
  };

  // --- Group 1: job completion and timeliness -----------------------------
  const completedWithDates = jobs.filter(
    (j) =>
      ["customer_confirmed", "provider_completed"].includes(j.status) &&
      j.expected_completion_date &&
      j.actual_completion_date,
  );
  const onTime = completedWithDates.filter(
    (j) => j.actual_completion_date <= j.expected_completion_date,
  );

  const today = new Date().toISOString().slice(0, 10);
  const stillOpenAndLate = jobs.filter(
    (j) =>
      ["scheduled", "in_progress", "delayed"].includes(j.status) &&
      j.expected_completion_date &&
      j.expected_completion_date < today,
  );

  const completion = {
    total: jobs.length,
    // Deliberately four separate figures. Adding them would claim work was
    // verified that nobody verified.
    providerReportedComplete: jobStatus.provider_completed || 0,
    customerConfirmed: jobStatus.customer_confirmed || 0,
    disputed: jobStatus.disputed || 0,
    unverifiable: jobStatus.unverifiable || 0,
    cancelled: jobStatus.cancelled || 0,
    stillOpen:
      (jobStatus.awarded || 0) + (jobStatus.scheduled || 0) + (jobStatus.in_progress || 0) + (jobStatus.delayed || 0),
    // Of jobs a provider reported complete, how many did a customer confirm?
    confirmationRate: rate(
      jobStatus.customer_confirmed || 0,
      (jobStatus.customer_confirmed || 0) + (jobStatus.provider_completed || 0) + (jobStatus.unverifiable || 0),
    ),
    onTime: rate(onTime.length, completedWithDates.length),
    currentlyOverdue: stillOpenAndLate.length,
    // Job values only. No cost, no margin.
    valueOfConfirmedWork: sumAmounts(
      jobs.filter((j) => j.status === "customer_confirmed").map((j) => j.agreed_price).filter((v) => v !== null),
    ),
  };

  // --- Group 2: satisfaction ----------------------------------------------
  const average = (rows, field) => {
    const values = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
    return values.length
      ? { average: Number((values.reduce((a, b) => a + Number(b), 0) / values.length).toFixed(2)), responses: values.length }
      : { average: null, responses: 0 };
  };
  const yesRate = (rows, field) => {
    const answered = rows.filter((r) => r[field] !== null && r[field] !== undefined);
    return rate(answered.filter((r) => r[field] === true).length, answered.length);
  };

  // A customer could be asked once a job reached an outcome.
  const surveyEligible =
    (jobStatus.customer_confirmed || 0) + (jobStatus.disputed || 0) + (jobStatus.unverifiable || 0);

  const satisfaction = {
    customer: {
      // Stated first, so no average is read without it.
      responseRate: rate(surveys.length, surveyEligible),
      overall: average(surveys, "overall_rating"),
      quality: average(surveys, "quality_rating"),
      timeliness: average(surveys, "timeliness_rating"),
      professionalism: average(surveys, "professionalism_rating"),
      communication: average(surveys, "communication_rating"),
      scopeAsAgreed: yesRate(surveys, "scope_as_agreed"),
      wouldRecommend: yesRate(surveys, "would_recommend"),
      wouldUseAgain: yesRate(surveys, "would_use_smartlink_again"),
      byOutcome: countBy(confirmations, "outcome"),
    },
    provider: {
      responses: providerSurveys.length,
      opportunityWorthwhile: yesRate(providerSurveys, "opportunity_worthwhile"),
      wouldAcceptSimilar: yesRate(providerSurveys, "would_accept_similar"),
      requestDescribedAccurately: yesRate(providerSurveys, "request_described_accurately"),
      customerResponsive: yesRate(providerSurveys, "customer_responsive"),
    },
    // The platform's own conversion figure against what providers say
    // independently. A gap between them means one of the two is wrong, and
    // that is worth knowing before either is quoted to anyone.
    conversionCrossCheck: {
      providerReported: yesRate(providerSurveys, "resulted_in_job"),
      platformMeasured: rate(smartlinkJobs.length, acceptedIntroductions.length),
    },
  };

  // --- Group 3: support and complaints ------------------------------------
  const support = {
    disputedJobs: jobStatus.disputed || 0,
    suspiciousLeadReports: {
      total: suspicious.length,
      awaitingReview: suspicious.filter((r) => r.status === "new").length,
      actioned: suspicious.filter((r) => r.status === "actioned").length,
      dismissed: suspicious.filter((r) => r.status === "dismissed").length,
      byReason: countBy(suspicious, "reason"),
    },
    // Stated rather than left as an empty section: a report that silently
    // omits a group reads as "none", which is a different claim from "not
    // built yet".
    ticketing: {
      available: false,
      note: "The support ticket system is not built yet, so complaint volumes and resolution times cannot be reported.",
    },
  };

  // --- Group 4: continual improvement -------------------------------------
  const improvement = {
    available: false,
    note: "The continual improvement register is not built yet. Disputed jobs and suspicious lead reports above are the current sources of improvement candidates.",
    candidateSignals: {
      disputedJobs: jobStatus.disputed || 0,
      unverifiableJobs: jobStatus.unverifiable || 0,
      requestsDescribedInaccurately: yesRate(providerSurveys, "request_described_accurately"),
    },
  };

  return { funnel, completion, satisfaction, support, improvement };
}

async function requireInstalled() {
  // Nothing to install: reporting reads tables other features own. Exposed as
  // a function so the controller's shape matches the other services.
  return true;
}

module.exports = {
  rate,
  getProviderReport,
  getAdminReport,
  requireInstalled,
};
