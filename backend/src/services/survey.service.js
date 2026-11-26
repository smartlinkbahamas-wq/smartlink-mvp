const { AppError } = require("../utils/app-error");
const { requireSupabase } = require("../utils/supabase-guard");

/**
 * Surveys.
 *
 * Two of them, deliberately asymmetric:
 *
 * The customer's rides on the completion confirmation, so they get one message
 * rather than two. Only the overall rating is required -- a form demanding
 * nine answers is one most people abandon, and a confirmation with one rating
 * is worth far more than a perfect form nobody finishes.
 *
 * The provider's asks whether the opportunity was worth having. It never asks
 * about revenue or profit: providers were promised they would not have to
 * disclose that, and the table has nowhere to put it.
 *
 * resulted_in_job is the column that matters most. It is the provider's own
 * answer to the question the platform also measures for itself from the jobs
 * table, and comparing the two is how anyone finds out whether the platform's
 * conversion figures are honest.
 */

const NOT_INSTALLED = "Surveys are not set up yet. Run sql/install_surveys.sql.";

function tableIsMissing(error) {
  return error?.code === "42P01" || /schema cache/i.test(error?.message || "");
}

function guard(error, message) {
  if (tableIsMissing(error)) {
    throw new AppError(NOT_INSTALLED, 503, { code: "surveys_not_installed" });
  }
  throw new AppError(message, 500, error.message);
}

// --- Customer satisfaction -------------------------------------------------

async function getCustomerSurvey(jobId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from("customer_satisfaction_surveys")
    .select("*")
    .eq("job_id", jobId)
    .maybeSingle();

  if (error) {
    if (tableIsMissing(error)) return null;
    throw new AppError("Could not load that survey.", 500, error.message);
  }
  return data;
}

/**
 * Records the customer's satisfaction answers.
 *
 * When they opt in to a public review, a row is created in expert_reviews with
 * review_status 'pending', so it goes through the moderation that already
 * exists. A separate record rather than a visibility flag on this one: a
 * public review and a confidential survey are different things, and one row
 * with a boolean would eventually be published by accident.
 *
 * The public review failing never fails the survey. The survey is the record
 * that matters; the review is an optional extra the customer offered.
 */
async function submitCustomerSurvey(jobId, payload, { expertId = null, leadId = null } = {}) {
  const supabase = requireSupabase();

  let expertReviewId = null;

  if (payload.publicReviewOptIn && expertId) {
    const { data: review, error: reviewError } = await supabase
      .from("expert_reviews")
      .insert({
        expert_id: expertId,
        lead_id: leadId,
        public_star_rating: payload.overallRating,
        public_review_comment: payload.comments?.trim() || null,
        would_recommend: payload.wouldRecommend ?? null,
        // Pending, so it is moderated before anyone sees it. Nothing here
        // publishes a review directly.
        review_status: "pending",
      })
      .select("feedback_id")
      .single();

    if (reviewError) {
      console.warn("[surveys] could not create the public review:", reviewError.message);
    } else {
      expertReviewId = review.feedback_id;
    }
  }

  const { data, error } = await supabase
    .from("customer_satisfaction_surveys")
    .insert({
      job_id: jobId,
      expert_id: expertId,
      overall_rating: payload.overallRating,
      quality_rating: payload.qualityRating ?? null,
      timeliness_rating: payload.timelinessRating ?? null,
      professionalism_rating: payload.professionalismRating ?? null,
      communication_rating: payload.communicationRating ?? null,
      scope_as_agreed: payload.scopeAsAgreed ?? null,
      would_recommend: payload.wouldRecommend ?? null,
      would_use_smartlink_again: payload.wouldUseAgain ?? null,
      comments: payload.comments?.trim() || null,
      public_review_opt_in: Boolean(payload.publicReviewOptIn),
      expert_review_id: expertReviewId,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("You have already answered for this job.", 409, {
        code: "survey_already_submitted",
      });
    }
    guard(error, "Could not record your answers.");
  }

  return data;
}

// --- Provider follow-up ----------------------------------------------------

/**
 * Jobs this provider could still be surveyed about.
 *
 * Closed jobs with no survey yet. Open work is excluded: asking whether an
 * opportunity was worthwhile before it has finished produces an answer about
 * the provider's mood, not about the opportunity.
 */
async function listPendingProviderSurveys(expertId) {
  const supabase = requireSupabase();

  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("id, reference, job_name, customer_name, status, source, actual_completion_date, created_at")
    .eq("expert_id", expertId)
    .in("status", ["customer_confirmed", "provider_completed", "unverifiable", "cancelled"])
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    if (tableIsMissing(error)) return [];
    throw new AppError("Could not load your jobs.", 500, error.message);
  }
  if (!jobs || jobs.length === 0) return [];

  const { data: answered, error: answeredError } = await supabase
    .from("provider_followup_surveys")
    .select("job_id")
    .eq("expert_id", expertId)
    .in("job_id", jobs.map((job) => job.id));

  if (answeredError && !tableIsMissing(answeredError)) {
    console.warn("[surveys] could not read existing answers:", answeredError.message);
  }

  const done = new Set((answered || []).map((row) => row.job_id));
  return jobs.filter((job) => !done.has(job.id));
}

async function submitProviderSurvey(expertId, payload) {
  const supabase = requireSupabase();

  if (!payload.jobId && !payload.introductionRequestId) {
    throw new AppError("The survey must be about a job or an opportunity.", 400, {
      code: "survey_subject_required",
    });
  }

  const { data, error } = await supabase
    .from("provider_followup_surveys")
    .insert({
      expert_id: expertId,
      job_id: payload.jobId || null,
      introduction_request_id: payload.introductionRequestId || null,
      resulted_in_job: Boolean(payload.resultedInJob),
      was_completed: payload.wasCompleted ?? null,
      request_described_accurately: payload.requestDescribedAccurately ?? null,
      customer_responsive: payload.customerResponsive ?? null,
      opportunity_worthwhile: payload.opportunityWorthwhile ?? null,
      would_accept_similar: payload.wouldAcceptSimilar ?? null,
      suggestions: payload.suggestions?.trim() || null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new AppError("You have already answered for this one.", 409, {
        code: "survey_already_submitted",
      });
    }
    if (error.code === "23514") {
      throw new AppError("The survey must be about a job or an opportunity.", 400, {
        code: "survey_subject_required",
      });
    }
    guard(error, "Could not record your answers.");
  }

  return data;
}

// --- Reporting -------------------------------------------------------------

/**
 * Survey figures, with their response rates.
 *
 * An average with no response rate beside it is misleading: 4.9 from two
 * replies out of eighty is not the same claim as 4.9 from seventy. Every
 * average returned here carries the count it came from, and the denominator it
 * was drawn from.
 */
async function getSurveyStatistics({ expertId = null } = {}) {
  const supabase = requireSupabase();

  let surveyQuery = supabase
    .from("customer_satisfaction_surveys")
    .select("overall_rating, quality_rating, timeliness_rating, professionalism_rating, communication_rating, would_recommend, would_use_smartlink_again, scope_as_agreed");
  if (expertId) surveyQuery = surveyQuery.eq("expert_id", expertId);

  let jobQuery = supabase
    .from("jobs")
    .select("id, status", { count: "exact" })
    .in("status", ["customer_confirmed", "disputed", "unverifiable"]);
  if (expertId) jobQuery = jobQuery.eq("expert_id", expertId);

  const [surveysResult, jobsResult, providerResult] = await Promise.all([
    surveyQuery,
    jobQuery,
    expertId
      ? supabase.from("provider_followup_surveys").select("resulted_in_job, opportunity_worthwhile, would_accept_similar, request_described_accurately, customer_responsive").eq("expert_id", expertId)
      : supabase.from("provider_followup_surveys").select("resulted_in_job, opportunity_worthwhile, would_accept_similar, request_described_accurately, customer_responsive"),
  ]);

  if (surveysResult.error && tableIsMissing(surveysResult.error)) {
    return { installed: false };
  }

  const surveys = surveysResult.data || [];
  const jobs = jobsResult.data || [];
  const providerSurveys = providerResult.data || [];

  const average = (field) => {
    const values = surveys.map((s) => s[field]).filter((v) => v !== null && v !== undefined);
    if (values.length === 0) return { average: null, responses: 0 };
    return {
      average: Number((values.reduce((a, b) => a + Number(b), 0) / values.length).toFixed(2)),
      responses: values.length,
    };
  };

  const yesRate = (rows, field) => {
    const answered = rows.filter((r) => r[field] !== null && r[field] !== undefined);
    if (answered.length === 0) return { yes: 0, answered: 0, percent: null };
    const yes = answered.filter((r) => r[field] === true).length;
    return {
      yes,
      answered: answered.length,
      percent: Number(((yes / answered.length) * 100).toFixed(1)),
    };
  };

  // Jobs that reached an outcome are the denominator: those are the jobs a
  // customer could have been asked about.
  const eligible = jobs.length;

  return {
    installed: true,
    customer: {
      // The rate is stated first, deliberately, so nobody reads an average
      // without it.
      responseRate: {
        responses: surveys.length,
        eligible,
        percent: eligible > 0 ? Number(((surveys.length / eligible) * 100).toFixed(1)) : null,
      },
      overall: average("overall_rating"),
      quality: average("quality_rating"),
      timeliness: average("timeliness_rating"),
      professionalism: average("professionalism_rating"),
      communication: average("communication_rating"),
      scopeAsAgreed: yesRate(surveys, "scope_as_agreed"),
      wouldRecommend: yesRate(surveys, "would_recommend"),
      wouldUseAgain: yesRate(surveys, "would_use_smartlink_again"),
    },
    provider: {
      responses: providerSurveys.length,
      // The provider's own account of conversion, to be compared against what
      // the jobs table says rather than trusted on its own.
      resultedInJob: yesRate(providerSurveys, "resulted_in_job"),
      opportunityWorthwhile: yesRate(providerSurveys, "opportunity_worthwhile"),
      wouldAcceptSimilar: yesRate(providerSurveys, "would_accept_similar"),
      requestDescribedAccurately: yesRate(providerSurveys, "request_described_accurately"),
      customerResponsive: yesRate(providerSurveys, "customer_responsive"),
    },
  };
}

module.exports = {
  getCustomerSurvey,
  submitCustomerSurvey,
  listPendingProviderSurveys,
  submitProviderSurvey,
  getSurveyStatistics,
};
